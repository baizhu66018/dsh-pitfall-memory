/**
 * 总结的落盘与周期调度。
 *
 * 三级总结都写成 `summaries/<kind>-<key>.{json,md}`：
 *   session-<sessionId>  每次会话结束
 *   daily-YYYY-MM-DD     每天（当天实时刷新 + 跨天补昨天）
 *   weekly-YYYY-Www      每周（跨周时补上一周）
 *
 * 周期调度是“懒触发”：每次会话开始/会话结束时检查一次 state.json，
 * 缺什么补什么，不常驻定时器，也不依赖宿主是否长时间运行。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  buildDailyDigest,
  buildSessionDigest,
  buildWeeklyDigest,
  renderDailyDigest,
  renderSessionDigest,
  renderWeeklyDigest,
} from './summary.js'
import { clip, nowIso, readJson, writeJsonAtomic } from './util.js'

const STATE_SCHEMA = 'dsh-pitfall-memory/state.v1'

export class SummaryBook {
  constructor({ dir, store, config }) {
    this.dir = dir
    this.store = store
    this.config = config
    this.summariesDir = path.join(dir, 'summaries')
    this.stateFile = path.join(dir, 'state.json')
    this.state = readJson(this.stateFile, null) ?? { schema: STATE_SCHEMA }
    this.lastEnsure = ''
  }

  saveState() {
    this.state.schema = STATE_SCHEMA
    this.state.updatedAt = nowIso()
    try {
      writeJsonAtomic(this.stateFile, this.state)
    } catch {
      /* 诊断性文件，写失败不影响主流程 */
    }
  }

  /** 记录一次会话总结。 */
  recordSession({ sessionId, project, startedAt, observations, touched }) {
    const at = nowIso()
    const digest = buildSessionDigest({
      sessionId,
      project,
      at,
      startedAt,
      observations,
      touched,
    })
    if (digest.observations === 0) {
      this.state.lastSessionDigest = at
      this.saveState()
      return digest
    }
    this.write('session', sessionId, digest, renderSessionDigest(digest))
    this.state.lastSessionDigest = at
    this.saveState()
    return digest
  }

  /** 生成/刷新某天的日总结。没有数据时不写文件。 */
  refreshDaily(dateKeyValue) {
    const observations = this.readObservations().filter((item) => localDateKey(item.at) === dateKeyValue)
    const lessonsToday = this.store.lessons.filter(
      (lesson) => localDateKey(lesson.firstSeen) === dateKeyValue || localDateKey(lesson.lastSeen) === dateKeyValue,
    )
    if (observations.length === 0 && lessonsToday.length === 0) return undefined
    const sessionDigests = this.readSessionDigestsFor(dateKeyValue)
    const digest = buildDailyDigest({
      date: dateKeyValue,
      observations,
      lessons: lessonsToday,
      sessionDigests,
    })
    this.write('daily', dateKeyValue, digest, renderDailyDigest(digest))
    return digest
  }

  /** 生成某周的周总结。没有日总结时不写。 */
  refreshWeekly(weekKeyValue) {
    const days = []
    for (const dateKeyValue of weekDates(weekKeyValue)) {
      const day = readJson(path.join(this.summariesDir, `daily-${dateKeyValue}.json`), null)
      if (day) days.push(day)
    }
    if (days.length === 0) return undefined
    const digest = buildWeeklyDigest({
      week: weekKeyValue,
      days,
      lessons: this.store.lessons,
    })
    this.write('weekly', weekKeyValue, digest, renderWeeklyDigest(digest))
    return digest
  }

  /**
   * 懒触发：补齐缺失的日/周总结。
   * 每天第一次调用生成昨天与今天的总结；跨周时补上一周。
   */
  ensure(now = new Date()) {
    const today = localDateKey(now)
    const checks = []
    if (this.state.lastDaily !== today) {
      const yesterday = localDateKey(new Date(now.getTime() - 86400000))
      checks.push(['daily', yesterday], ['daily', today])
      this.state.lastDaily = today
    }
    const week = localWeekKey(now)
    if (this.state.lastWeekly !== week) {
      checks.push(['weekly', localWeekKey(new Date(now.getTime() - 7 * 86400000))])
      this.state.lastWeekly = week
    }
    for (const [kind, key] of checks) {
      try {
        if (kind === 'daily') this.refreshDaily(key)
        else this.refreshWeekly(key)
      } catch (error) {
        // 周期总结失败不应影响会话
        this.state.lastError = clip(String(error?.message ?? error), 200)
      }
    }
    if (checks.length > 0) this.saveState()
    this.lastEnsure = today
    return checks
  }

  /** 最近一份日总结（用于注入）。 */
  latestDaily() {
    const file = this.latestFile('daily')
    return file ? readJson(file, null) : null
  }

  /** 最近一份周总结（用于注入）。 */
  latestWeekly() {
    const file = this.latestFile('weekly')
    return file ? readJson(file, null) : null
  }

  latestFile(kind) {
    try {
      const files = fs
        .readdirSync(this.summariesDir)
        .filter((name) => name.startsWith(`${kind}-`) && name.endsWith('.json'))
        .sort()
      const last = files[files.length - 1]
      return last ? path.join(this.summariesDir, last) : undefined
    } catch {
      return undefined
    }
  }

  readSessionDigestsFor(dateKeyValue) {
    try {
      return fs
        .readdirSync(this.summariesDir)
        .filter((name) => name.startsWith('session-') && name.endsWith('.json'))
        .map((name) => readJson(path.join(this.summariesDir, name), null))
        .filter((digest) => digest && localDateKey(digest.at) === dateKeyValue)
    } catch {
      return []
    }
  }

  readObservations() {
    const rows = []
    for (const file of [this.store.observationsFile, `${this.store.observationsFile}.1`]) {
      let text = ''
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          rows.push(JSON.parse(line))
        } catch {
          /* 半截行忽略 */
        }
      }
    }
    return rows
  }

  /** 设置页用：列出某一类总结的文件名（新的在前）。 */
  listSummaryFiles(kind) {
    try {
      return fs
        .readdirSync(this.summariesDir)
        .filter((name) => name.startsWith(`${kind}-`) && name.endsWith('.md'))
        .sort()
        .reverse()
        .map((name) => name.replace(/\.md$/, ''))
    } catch {
      return []
    }
  }

  /** 设置页用：立刻重算当天的日总结与本周的周总结。 */
  refreshNow() {
    const today = localDateKey(new Date())
    const week = localWeekKey(new Date())
    const daily = this.refreshDaily(today)
    for (const date of weekDates(week)) this.refreshDaily(date)
    const weekly = this.refreshWeekly(week)
    return {
      daily: daily ? today : '',
      weekly: weekly ? week : '',
    }
  }

  write(kind, key, digest, markdown) {
    const base = path.join(this.summariesDir, `${kind}-${key}`)
    try {
      fs.mkdirSync(this.summariesDir, { recursive: true })
      writeJsonAtomic(`${base}.json`, digest)
      fs.writeFileSync(`${base}.md`, `${markdown}\n`, 'utf8')
    } catch (error) {
      this.state.lastError = clip(String(error?.message ?? error), 200)
    }
  }
}

/** 本地时区的 YYYY-MM-DD。 */
export function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** ISO 周：YYYY-Www。 */
export function localWeekKey(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const day = target.getUTCDay() || 7
  target.setUTCDate(target.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((target - yearStart) / 86400000 + 1) / 7)
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** 某 ISO 周的 7 个日期键。 */
export function weekDates(weekKeyValue) {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekKeyValue ?? '')
  if (!match) return []
  const year = Number(match[1])
  const week = Number(match[2])
  // ISO 周 1 的周一：1 月 4 日所在周的周一
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4Day = jan4.getUTCDay() || 7
  const monday = new Date(jan4.getTime() - (jan4Day - 1) * 86400000 + (week - 1) * 7 * 86400000)
  const dates = []
  for (let index = 0; index < 7; index += 1) {
    const date = new Date(monday.getTime() + index * 86400000)
    dates.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`)
  }
  return dates
}