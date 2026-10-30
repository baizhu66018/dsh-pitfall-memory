/**
 * 经验库：把观察（observation）合并成经验（lesson），并负责持久化。
 *
 * 存储布局（默认 <profile>/.dsh-pitfall-memory/）：
 *   lessons.json        结构化经验库（唯一真相）
 *   lessons.md          人可读清单（由 index.js 渲染写入）
 *   observations.ndjson 原始失败证据（追加，超 1MB 轮转）
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildRuleCards } from './summary.js'
import { appendNdjson, clip, nowIso, readJson, sha1, writeJsonAtomic } from './util.js'

const SCHEMA = 'dsh-pitfall-memory/lessons.v1'

export class PitfallStore {
  /**
   * @param {object} options
   * @param {string} options.dir 存储目录
   * @param {object} options.config 已归一化的配置
   * @param {(store: PitfallStore) => void} [options.onPersist] 落盘后的回调（写 lessons.md）
   */
  constructor({ dir, config, onPersist }) {
    this.dir = dir
    this.config = config
    this.onPersist = onPersist
    this.file = path.join(dir, 'lessons.json')
    this.observationsFile = path.join(dir, 'observations.ndjson')
    this.lessons = []
    this.updatedAt = nowIso()
    this.saveTimer = undefined
    this.closed = false
    this.load()
  }

  load() {
    const parsed = readJson(this.file, null)
    if (parsed && Array.isArray(parsed.lessons)) {
      this.lessons = parsed.lessons.filter(isLessonLike).map(normalizeLesson)
      this.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : nowIso()
    }
  }

  /**
   * 首次运行（库为空）时写入种子经验。
   * @returns {number} 写入条数；库非空时返回 0。
   */
  seedIfEmpty(entries) {
    if (this.lessons.length > 0) return 0
    for (const entry of entries ?? []) {
      if (this.lessons.some((lesson) => lesson.signature === entry.signature)) continue
      this.lessons.push(normalizeLesson(entry))
    }
    if (this.lessons.length > 0) this.save()
    return this.lessons.length
  }

  /** 登记一批观察；相同签名合并计数。返回受影响的 lesson 列表。 */
  addObservations(observations, { project = '', sessionId = '' } = {}) {
    const touched = []
    for (const obs of observations ?? []) {
      if (!obs || typeof obs.signature !== 'string' || obs.signature === '') continue
      appendNdjson(this.observationsFile, {
        at: obs.at ?? nowIso(),
        signature: obs.signature,
        // ruleId/category 必须落盘：日/周汇总靠它们归到根因族，
        // 少了就会全部落到 unknown，总结只剩一句「未归类最常见」。
        ruleId: obs.ruleId ?? '',
        category: obs.category ?? '',
        title: obs.title ?? '',
        tool: obs.toolName ?? '',
        command: obs.command ?? '',
        symptom: clip(obs.symptom ?? '', 300),
        project,
        sessionId,
      })
      const lesson = this.upsert(obs, project, sessionId)
      touched.push(lesson)
    }
    if (touched.length > 0) this.scheduleSave()
    return touched
  }

  upsert(obs, project, sessionId) {
    const now = obs.at ?? nowIso()
    let lesson = this.lessons.find((item) => item.signature === obs.signature)
    if (!lesson) {
      lesson = {
        id: `pm-${sha1(obs.signature).slice(0, 10)}`,
        signature: obs.signature,
        ruleId: obs.ruleId ?? '',
        category: obs.category ?? 'command',
        title: obs.title ?? '未分类失败',
        severity: Number.isFinite(obs.severity) ? obs.severity : 1,
        advice: obs.advice ?? '',
        symptom: clip(obs.symptom ?? '', 400),
        occurrences: 0,
        firstSeen: now,
        lastSeen: now,
        projects: [],
        sessions: [],
        examples: [],
        source: 'auto',
        status: 'active',
      }
      this.lessons.push(lesson)
    }
    lesson.occurrences += 1
    lesson.lastSeen = now
    if (observationsGap(lesson.symptom, obs.symptom)) lesson.symptom = clip(obs.symptom ?? '', 400)
    // 已标记解决的坑再次出现：说明其实没解决，自动复活。
    lesson.status = lesson.status === 'resolved' ? 'active' : lesson.status
    if (project) addUnique(lesson.projects, project, 8)
    if (sessionId) addUnique(lesson.sessions, sessionId, 5)
    lesson.examples.unshift({
      at: now,
      tool: clip(obs.toolName ?? '', 40),
      command: clip(obs.command ?? '', 160),
      symptom: clip(obs.symptom ?? '', 200),
    })
    lesson.examples = lesson.examples.slice(0, 3)
    this.prune()
    return lesson
  }

  /** 手动记录/覆盖一条经验（同签名则更新）。 */
  remember({ title, symptom, advice, category = 'tooling', scope = 'project', project = '', signature }) {
    const now = nowIso()
    const sig = signature || `manual:${sha1(`${title}|${symptom}`).slice(0, 12)}`
    let lesson = this.lessons.find((item) => item.signature === sig)
    if (!lesson) {
      lesson = {
        id: `pm-${sha1(sig).slice(0, 10)}`,
        signature: sig,
        ruleId: 'manual',
        category,
        title,
        severity: 3,
        advice,
        symptom,
        occurrences: 1,
        firstSeen: now,
        lastSeen: now,
        projects: [],
        sessions: [],
        examples: [],
        source: 'manual',
        status: 'active',
      }
      this.lessons.push(lesson)
    } else {
      lesson.title = title
      lesson.symptom = symptom
      lesson.advice = advice
      lesson.category = category
      lesson.source = 'manual'
      lesson.lastSeen = now
      lesson.status = 'active'
    }
    const projects = scope === 'global' ? ['*'] : project ? [project] : lesson.projects
    lesson.projects = projects.length > 0 ? projects : ['*']
    this.prune()
    this.scheduleSave()
    return lesson
  }

  /** 改变经验状态：active / resolved / muted。 */
  setStatus(id, status) {
    const lesson = this.lessons.find((item) => item.id === id || item.signature === id)
    if (!lesson) return undefined
    lesson.status = status
    this.scheduleSave()
    return lesson
  }

  /** 设置页用：从活跃经验压出规则卡。 */
  ruleCardsForUi() {
    const active = this.lessons.filter((lesson) => lesson.status === 'active')
    return buildRuleCards(active, { max: 12 }).map((card) => ({
      root: card.root,
      rootLabel: card.rootLabel,
      icon: card.icon,
      line: card.line,
      lessonId: card.lessonId,
    }))
  }

  /** 设置页用：读最近的心跳行。 */
  heartbeat() {
    try {
      const text = fs.readFileSync(path.join(this.dir, '.heartbeat.jsonl'), 'utf8')
      return text
        .split('\n')
        .filter(Boolean)
        .slice(-40)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return undefined
          }
        })
        .filter(Boolean)
    } catch {
      return []
    }
  }

  /**
   * 列出经验。
   * @param {object} [filter]
   * @param {string} [filter.status] 'active' | 'resolved' | 'muted' | 'all'
   * @param {string} [filter.category]
   * @param {string} [filter.project] 项目键；只保留项目内或全局经验
   * @param {boolean} [filter.projectScoped]
   * @param {number} [filter.limit]
   */
  list(filter = {}) {
    const status = filter.status ?? 'active'
    const project = filter.project ?? ''
    const projectScoped = filter.projectScoped !== false
    const limit = Number.isFinite(filter.limit) ? Math.max(1, filter.limit) : 50
    const rows = this.lessons.filter((lesson) => {
      if (status !== 'all' && lesson.status !== status) return false
      if (filter.category && lesson.category !== filter.category) return false
      if (projectScoped && project && !lesson.projects.includes('*') && !lesson.projects.includes(project)) {
        return false
      }
      return true
    })
    return sortLessons(rows).slice(0, limit)
  }

  /** 注入用：活跃、达到出现次数门槛、与项目相关。 */
  forInjection(project) {
    const min = Math.max(1, this.config.minOccurrences ?? 1)
    return sortLessons(
      this.lessons.filter((lesson) => {
        if (lesson.status !== 'active') return false
        if (lesson.occurrences < min) return false
        if (this.config.projectScoped === false) return true
        return lesson.projects.includes('*') || (project !== '' && lesson.projects.includes(project))
      }),
    )
  }

  stats() {
    const byStatus = {}
    const byCategory = {}
    for (const lesson of this.lessons) {
      byStatus[lesson.status] = (byStatus[lesson.status] ?? 0) + 1
      byCategory[lesson.category] = (byCategory[lesson.category] ?? 0) + 1
    }
    return {
      total: this.lessons.length,
      byStatus,
      byCategory,
      file: this.file,
      dir: this.dir,
      top: sortLessons(this.lessons).slice(0, 5).map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        occurrences: lesson.occurrences,
      })),
    }
  }

  /** 超出上限时淘汰最久没出现、次数最少的自动经验；手动经验保留。 */
  prune() {
    const max = Math.max(20, this.config.maxLessonsStored ?? 300)
    if (this.lessons.length <= max) return
    const removable = this.lessons
      .filter((lesson) => lesson.source === 'auto')
      .sort((a, b) => (a.lastSeen < b.lastSeen ? -1 : 1))
    while (this.lessons.length > max && removable.length > 0) {
      const victim = removable.shift()
      this.lessons = this.lessons.filter((lesson) => lesson !== victim)
    }
  }

  scheduleSave() {
    if (this.closed) return
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.save()
    }, 400)
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref()
  }

  save() {
    if (this.closed) return
    this.updatedAt = nowIso()
    try {
      writeJsonAtomic(this.file, {
        schema: SCHEMA,
        updatedAt: this.updatedAt,
        lessons: this.lessons,
      })
      this.rotateObservations()
      this.onPersist?.(this)
    } catch (error) {
      console.warn(`[dsh-pitfall-memory] 写入经验库失败：${error && error.message ? error.message : error}`)
    }
  }

  rotateObservations() {
    try {
      const stat = fs.statSync(this.observationsFile)
      if (stat.size > 1024 * 1024) {
        fs.renameSync(this.observationsFile, `${this.observationsFile}.1`)
      }
    } catch {
      /* 文件不存在时不处理 */
    }
  }

  close() {
    if (this.closed) return
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    this.save()
    this.closed = true
  }
}

function isLessonLike(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.signature === 'string' &&
    typeof value.title === 'string'
  )
}

function normalizeLesson(value) {
  return {
    ...value,
    projects: Array.isArray(value.projects) ? value.projects.filter((item) => typeof item === 'string') : [],
    sessions: Array.isArray(value.sessions) ? value.sessions.filter((item) => typeof item === 'string') : [],
    examples: Array.isArray(value.examples) ? value.examples.filter((item) => item && typeof item === 'object') : [],
    occurrences: Number.isFinite(value.occurrences) ? value.occurrences : 1,
    severity: Number.isFinite(value.severity) ? value.severity : 1,
    status: typeof value.status === 'string' ? value.status : 'active',
    source: value.source === 'manual' ? 'manual' : value.source === 'seed' ? 'seed' : 'auto',
  }
}

function addUnique(list, value, max) {
  if (!list.includes(value)) list.push(value)
  while (list.length > max) list.shift()
}

/** 更换症状展示的条件：新症状更长或含更明确的错误行。 */
function observationsGap(oldSymptom, newSymptom) {
  if (!newSymptom) return false
  if (!oldSymptom) return true
  return newSymptom.length > oldSymptom.length && newSymptom.length <= 400
}

export function sortLessons(rows) {
  return [...rows].sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences
    return a.lastSeen < b.lastSeen ? 1 : -1
  })
}