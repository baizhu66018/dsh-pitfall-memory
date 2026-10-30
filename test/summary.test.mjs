/**
 * 总结框架测试：四层收敛（观察→经验→模式→规则）与日/周周期。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { SummaryBook, localDateKey, localWeekKey, weekDates } from '../lib/rollups.js'
import { PitfallStore } from '../lib/store.js'
import {
  buildDailyDigest,
  buildPatterns,
  buildRuleCards,
  buildSessionDigest,
  buildWeeklyDigest,
  rootCauseOf,
  ruleLineOf,
} from '../lib/summary.js'

const BASE = path.join(os.tmpdir(), 'dsh-pitfall-memory-tests', path.basename(import.meta.dirname, '.mjs'))

function tempDir(name) {
  const dir = path.join(BASE, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function lesson(overrides = {}) {
  return {
    id: 'pm-1',
    signature: 'sandbox:sandbox-denied:c',
    ruleId: 'sandbox-denied',
    category: 'sandbox',
    title: '写入被沙箱拒绝',
    severity: 3,
    symptom: 'Permission denied',
    advice: '写操作只落工作区。第二条建议不该出现在规则卡里。',
    occurrences: 1,
    firstSeen: '2026-10-30T04:00:00.000Z',
    lastSeen: '2026-10-30T04:00:00.000Z',
    projects: ['e:/dsh'],
    status: 'active',
    source: 'auto',
    ...overrides,
  }
}

test('根因族：规则优先于类别', () => {
  assert.equal(rootCauseOf({ ruleId: 'python-pipe', category: 'runtime' }), 'restricted-token')
  assert.equal(rootCauseOf({ ruleId: 'sandbox-denied', category: 'sandbox' }), 'sandbox-boundary')
  assert.equal(rootCauseOf({ ruleId: 'seed:xxx', category: 'encoding' }), 'cjk-encoding')
  assert.equal(rootCauseOf({ category: 'unknown-category' }), 'unknown')
})

test('规则卡取每条建议的首句，且同根因最多两条', () => {
  const lessons = [
    lesson({ id: 'a', advice: '第一句。第二句。', severity: 3 }),
    lesson({ id: 'b', ruleId: 'pip-locked', advice: '用 pkg-install。', severity: 2 }),
    lesson({ id: 'c', ruleId: 'mkdtemp-locked', advice: '不要 mkdtemp。', severity: 1 }),
  ]
  assert.equal(ruleLineOf(lessons[0]), '第一句。')
  const cards = buildRuleCards(lessons, { max: 8 })
  assert.equal(cards.filter((card) => card.root === 'restricted-token').length, 2)
  assert.equal(cards.length, 3)
  assert.equal(cards[0].lessonId, 'a')
})

test('模式按根因聚合并按次数排序', () => {
  const patterns = buildPatterns([
    lesson({ id: 'a', ruleId: 'sandbox-denied', occurrences: 2 }),
    lesson({ id: 'b', ruleId: 'dsh-home-write', occurrences: 3 }),
    lesson({ id: 'c', ruleId: 'python-pipe', occurrences: 1 }),
  ])
  assert.equal(patterns[0].key, 'sandbox-boundary')
  assert.equal(patterns[0].occurrences, 5)
  assert.equal(patterns[1].key, 'restricted-token')
})

test('会话总结区分新坑与复发', () => {
  const digest = buildSessionDigest({
    sessionId: 's1',
    project: 'e:/dsh',
    at: '2026-10-30T05:00:00.000Z',
    startedAt: '2026-10-30T04:30:00.000Z',
    observations: [
      { ruleId: 'sandbox-denied' },
      { ruleId: 'python-pipe' },
      { ruleId: 'python-pipe' },
    ],
    touched: [
      lesson({ id: 'new', firstSeen: '2026-10-30T04:40:00.000Z' }),
      lesson({ id: 'old', firstSeen: '2026-10-01T00:00:00.000Z', occurrences: 4 }),
    ],
  })
  assert.equal(digest.observations, 3)
  assert.deepEqual(digest.fresh.map((item) => item.id), ['new'])
  assert.deepEqual(digest.repeated.map((item) => item.id), ['old'])
  assert.equal(digest.roots[0].key, 'restricted-token')
})

test('日总结给出根因排行与关键结论', () => {
  const digest = buildDailyDigest({
    date: '2026-10-30',
    observations: [{ ruleId: 'sandbox-denied' }, { ruleId: 'sandbox-denied' }, { ruleId: 'python-pipe' }],
    lessons: [
      lesson({ id: 'a', firstSeen: '2026-10-30T01:00:00.000Z' }),
      lesson({ id: 'b', firstSeen: '2026-10-01T00:00:00.000Z', lastSeen: '2026-10-30T02:00:00.000Z', occurrences: 3 }),
    ],
    sessionDigests: [{ id: 's1' }],
  })
  assert.equal(digest.observations, 3)
  assert.equal(digest.sessions, 1)
  assert.equal(digest.roots[0].key, 'sandbox-boundary')
  assert.equal(digest.roots[0].count, 2)
  assert.equal(digest.fresh.length, 1)
  assert.equal(digest.repeated.length, 1)
  assert.ok(digest.highlights.length >= 2)
})

test('周总结聚合多天并给出规则建议', () => {
  const digest = buildWeeklyDigest({
    week: '2026-W44',
    days: [
      { date: '2026-10-26', sessions: 1, observations: 2, roots: [{ key: 'sandbox-boundary', label: '沙箱边界', count: 2 }] },
      { date: '2026-10-27', sessions: 2, observations: 3, roots: [{ key: 'sandbox-boundary', label: '沙箱边界', count: 1 }, { key: 'restricted-token', label: '受限令牌', count: 2 }] },
    ],
    lessons: [lesson({ firstSeen: '2026-10-26T00:00:00.000Z' })],
  })
  assert.equal(digest.observations, 5)
  assert.equal(digest.sessions, 3)
  assert.equal(digest.roots[0].key, 'sandbox-boundary')
  assert.equal(digest.roots[0].count, 3)
  assert.equal(digest.rules.length, 1)
})

test('日期与 ISO 周', () => {
  const date = new Date(2026, 9, 30, 12, 0, 0)
  assert.equal(localDateKey(date), '2026-10-30')
  assert.equal(localWeekKey(date), '2026-W44')
  const dates = weekDates('2026-W44')
  assert.equal(dates.length, 7)
  assert.equal(dates[0], '2026-10-26')
  assert.equal(dates[6], '2026-11-01')
})

test('SummaryBook 生成日总结与周总结文件', () => {
  const dir = tempDir('summary-book')
  const store = new PitfallStore({ dir, config: resolveConfig({}) })
  store.addObservations(
    [
      {
        ruleId: 'sandbox-denied',
        category: 'sandbox',
        title: '写入被沙箱拒绝',
        severity: 3,
        signature: 'sandbox:sandbox-denied:c',
        symptom: 'Permission denied',
        advice: '只写工作区。',
        toolName: 'ops_bash',
        command: 'echo x > ~/.dsh/x',
        at: new Date().toISOString(),
      },
    ],
    { project: 'e:/dsh', sessionId: 's1' },
  )
  store.save()

  const book = new SummaryBook({ dir, store, config: resolveConfig({}) })
  const checks = book.ensure(new Date())
  assert.ok(checks.length > 0, 'ensure 应补齐周期总结')

  const today = localDateKey(new Date())
  const dailyFile = path.join(dir, 'summaries', `daily-${today}.md`)
  assert.ok(fs.existsSync(dailyFile), '日总结文件应存在')
  assert.match(fs.readFileSync(dailyFile, 'utf8'), /日总结/)

  const week = localWeekKey(new Date())
  const weekly = book.refreshWeekly(week)
  assert.ok(weekly, '周总结应生成')
  assert.ok(fs.existsSync(path.join(dir, 'summaries', `weekly-${week}.md`)))

  store.close()
})