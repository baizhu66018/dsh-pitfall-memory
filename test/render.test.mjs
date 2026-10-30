/**
 * 渲染测试：注入段落、重复提醒、人可读清单。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderInjection, renderLessonDetail, renderLessonsMarkdown, renderRepeatWarn } from '../lib/render.js'

function lesson(overrides = {}) {
  return {
    id: 'pm-1',
    signature: 'sandbox:denied:a',
    category: 'sandbox',
    title: '写入被沙箱拒绝',
    severity: 3,
    symptom: 'Permission denied: C:\\Users\\QQ\\.dsh\\x',
    advice: '只写 E:\\dsh 或 /tmp',
    occurrences: 3,
    firstSeen: '2026-10-01T00:00:00.000Z',
    lastSeen: '2026-10-30T00:00:00.000Z',
    projects: ['e:/dsh'],
    examples: [{ at: '2026-10-30T00:00:00.000Z', tool: 'ops_bash', command: 'echo x > ~/.dsh/x' }],
    source: 'auto',
    status: 'active',
    ...overrides,
  }
}

test('注入段落包含标题、症状、做法与计数', () => {
  const { text, count } = renderInjection([lesson()], {
    projectLabel: 'dsh',
    maxLessons: 12,
    maxBytes: 6000,
    storeFile: 'E:/x/lessons.md',
  })
  assert.equal(count, 1)
  assert.match(text, /踩坑经验/)
  assert.match(text, /写入被沙箱拒绝/)
  assert.match(text, /×3/)
  assert.match(text, /只写 E:\\dsh 或 \/tmp/)
  assert.match(text, /lessons\.md/)
})

test('字节上限会截断条目并说明省略数量', () => {
  const long = lesson({ title: '很长'.repeat(50), symptom: '痛'.repeat(300), advice: '做'.repeat(300) })
  const { text, count } = renderInjection([long, long, long, long], {
    maxLessons: 4,
    maxBytes: 1200,
  })
  assert.ok(count < 4)
  assert.match(text, /还有 \d+ 条经验/)
  assert.ok(Buffer.byteLength(text, 'utf8') <= 1400)
})

test('空经验不产生注入文本', () => {
  assert.deepEqual(renderInjection([], {}), { text: '', count: 0 })
})

test('重复提醒带次数与做法', () => {
  const text = renderRepeatWarn(lesson(), 2)
  assert.match(text, /第 2 次/)
  assert.match(text, /只写/)
})

test('人可读清单分组展示', () => {
  const markdown = renderLessonsMarkdown(
    [lesson(), lesson({ id: 'pm-2', status: 'resolved', title: '已解决的坑' })],
    { updatedAt: '2026-10-30T00:00:00.000Z', dir: 'E:/x' },
  )
  assert.match(markdown, /# 踩坑经验库/)
  assert.match(markdown, /## 活跃经验（1）/)
  assert.match(markdown, /## 已解决 \/ 已忽略/)
  assert.match(markdown, /✅/)
})

test('单条详情可读', () => {
  const text = renderLessonDetail(lesson())
  assert.match(text, /id: pm-1/)
  assert.match(text, /症状:/)
  assert.match(text, /正确做法:/)
  assert.match(text, /样例:/)
})