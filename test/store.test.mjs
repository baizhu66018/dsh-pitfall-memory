/**
 * 经验库合并、过滤、持久化测试。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { PitfallStore } from '../lib/store.js'

const BASE = path.join(os.tmpdir(), 'dsh-pitfall-memory-tests', path.basename(import.meta.dirname, '.mjs'))

function tempDir(name) {
  const dir = path.join(BASE, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function observation(signature, overrides = {}) {
  return {
    ruleId: 'sandbox-denied',
    category: 'sandbox',
    title: '写入被沙箱拒绝',
    severity: 3,
    key: 'c:/users',
    signature,
    symptom: 'Permission denied: C:\\Users\\QQ\\.dsh\\x',
    advice: '只写工作区',
    toolName: 'ops_bash',
    command: 'echo x > ~/.dsh/x',
    at: new Date().toISOString(),
    ...overrides,
  }
}

test('同一签名合并计数，并记录项目', () => {
  const dir = tempDir('merge')
  const store = new PitfallStore({ dir, config: resolveConfig({}) })
  store.addObservations([observation('sandbox:denied:a')], { project: 'e:/dsh', sessionId: 's1' })
  store.addObservations([observation('sandbox:denied:a')], { project: 'e:/dsh', sessionId: 's2' })
  const lesson = store.lessons.find((item) => item.signature === 'sandbox:denied:a')
  assert.ok(lesson)
  assert.equal(lesson.occurrences, 2)
  assert.deepEqual(lesson.projects, ['e:/dsh'])
  assert.equal(lesson.sessions.length, 2)
  store.close()
})

test('已解决的经验再次出现会自动复活', () => {
  const dir = tempDir('revive')
  const store = new PitfallStore({ dir, config: resolveConfig({}) })
  store.addObservations([observation('sandbox:denied:b')], { project: 'e:/dsh' })
  const lesson = store.lessons[0]
  store.setStatus(lesson.id, 'resolved')
  store.addObservations([observation('sandbox:denied:b')], { project: 'e:/dsh' })
  assert.equal(lesson.status, 'active')
  store.close()
})

test('手动经验可标记全局，并覆盖自动经验', () => {
  const dir = tempDir('manual')
  const store = new PitfallStore({ dir, config: resolveConfig({}) })
  const manual = store.remember({
    title: '不要用 python',
    symptom: 'Python was not found',
    advice: '用捆绑 Python',
    category: 'runtime',
    scope: 'global',
    project: 'e:/dsh',
  })
  assert.equal(manual.source, 'manual')
  assert.deepEqual(manual.projects, ['*'])
  assert.ok(store.forInjection('e:/other').some((item) => item.id === manual.id))
  store.close()
})

test('项目过滤：别的项目的经验不注入本项目', () => {
  const dir = tempDir('scope')
  const store = new PitfallStore({ dir, config: resolveConfig({}) })
  store.addObservations([observation('sandbox:denied:c')], { project: 'e:/dsh' })
  assert.equal(store.forInjection('e:/dsh').length, 1)
  assert.equal(store.forInjection('e:/other').length, 0)
  store.close()
})

test('持久化后重新加载', () => {
  const dir = tempDir('persist')
  const first = new PitfallStore({ dir, config: resolveConfig({}) })
  first.addObservations([observation('sandbox:denied:d')], { project: 'e:/dsh' })
  first.close()

  const second = new PitfallStore({ dir, config: resolveConfig({}) })
  assert.equal(second.lessons.length, 1)
  assert.equal(second.lessons[0].occurrences, 1)
  assert.ok(fs.existsSync(path.join(dir, 'lessons.json')))
  assert.ok(fs.existsSync(path.join(dir, 'observations.ndjson')))
  second.close()
})

test('prune 只淘汰自动经验', () => {
  const dir = tempDir('prune')
  const config = resolveConfig({ maxLessonsStored: 21 })
  const store = new PitfallStore({ dir, config })
  const manual = store.remember({
    title: '手工经验',
    symptom: 'x',
    advice: 'y',
    scope: 'global',
    project: 'e:/dsh',
  })
  for (let index = 0; index < 30; index += 1) {
    store.addObservations([observation(`sandbox:denied:p${index}`)], { project: 'e:/dsh' })
  }
  assert.ok(store.lessons.length <= 21)
  assert.ok(store.lessons.some((item) => item.id === manual.id))
  store.close()
})
test('证据文件写入 ruleId/category，供日/周汇总归类', () => {
  const dir = tempDir('evidence-fields')
  const store = new PitfallStore({ dir, config: resolveConfig({}) })
  store.addObservations(
    [
      {
        ruleId: 'python-placeholder',
        category: 'runtime',
        title: 'PATH 上的 python 是占位符',
        severity: 3,
        signature: 'runtime:python-placeholder:store-alias',
        symptom: 'Python was not found',
        advice: '用捆绑 Python',
        toolName: 'ops_bash',
        command: 'python --version',
        at: new Date().toISOString(),
      },
    ],
    { project: 'e:/dsh', sessionId: 's1' },
  )
  store.save()
  const line = fs.readFileSync(path.join(dir, 'observations.ndjson'), 'utf8').trim()
  const record = JSON.parse(line)
  assert.equal(record.ruleId, 'python-placeholder')
  assert.equal(record.category, 'runtime')
  assert.equal(record.tool, 'ops_bash')
  store.close()
})
