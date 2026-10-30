/**
 * 集成冒烟测试：用假 ctx/agent 走一遍「捕获 → 落库 → dynamic context 注入 → 工具/总结」。
 * 不依赖 DSH 运行时，但覆盖插件的接线逻辑。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { apply } from '../lib/index.js'
import { localDateKey } from '../lib/rollups.js'

const BASE = path.join(os.tmpdir(), 'dsh-pitfall-memory-tests', path.basename(import.meta.dirname, '.mjs'))

function tempDir(name) {
  const dir = path.join(BASE, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function fakeContext() {
  const listeners = new Map()
  const tools = []
  const disposers = []
  const contexts = []
  const injections = new Map()

  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    get() {
      return undefined
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    inject(deps, callback) {
      // 模拟 Cordis：服务就绪后立即执行回调，把 context 注册交给 fake systemPrompt。
      injections.set(deps.join(','), callback)
      if (deps.includes('systemPrompt')) {
        callback({ systemPrompt: { context: (definition) => contexts.push(definition) } })
      }
      return () => {}
    },
    effect(setup, _label) {
      const dispose = setup()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    disposeAll() {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
  return { ctx, tools, listeners, contexts }
}

function fakeAgent(id, cwd) {
  const injected = []
  return {
    id,
    injected,
    session: {
      id,
      header: { cwd },
      events: [],
      append() {},
    },
    inject(message) {
      injected.push(message)
    },
  }
}

/** 渲染本插件注册的 dynamic context（等价于宿主每轮装配时调用）。 */
function renderBriefingOf(contexts, agent) {
  const definition = contexts.find((item) => item.name === 'pitfall:briefing')
  assert.ok(definition, '应注册 pitfall:briefing dynamic context')
  return typeof definition.text === 'function' ? definition.text({ agent }) : definition.text
}

function failEvents(command = 'python --version', text = 'Python was not found...\n[exit code: 49]') {
  return [
    {
      type: 'tool/call',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, step: 1, callId: 'c1', name: 'ops_bash', arguments: JSON.stringify({ command }) },
    },
    {
      type: 'tool/result',
      seq: 2,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'm1',
          role: 'user',
          source: { kind: 'tool', callId: 'c1', toolName: 'ops_bash' },
          content: [{ type: 'tool-result', toolCallId: 'c1', isError: true, content: [{ type: 'text', text }] }],
        },
      },
    },
    { type: 'turn/end', seq: 3, time: Date.now(), data: { turn: 1, reason: 'success' } },
  ]
}

test('捕获失败 → 落库 → dynamic context 注入 → 工具可查', async () => {
  const dir = tempDir('smoke')
  const { ctx, tools, contexts } = fakeContext()
  apply(ctx, { storeDir: dir, repeatWarn: true, maxLessons: 5, seed: false })

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['pitfall_list', 'pitfall_remember', 'pitfall_resolve', 'pitfall_review', 'pitfall_summary'],
  )
  assert.equal(contexts.length, 1, '应注册一个 dynamic context')

  // 会话 1：库里还没有经验，context 渲染为空
  const agent1 = fakeAgent('s1', 'E:\\dsh')
  ctx.emit('agent/created', { agent: agent1 })
  assert.equal(renderBriefingOf(contexts, agent1), '', '首次没有历史经验时不注入')

  // 发生一次 python 占位符失败
  const session1 = { id: 's1', header: { cwd: 'E:\\dsh' } }
  for (const event of failEvents()) ctx.emit('session/event', session1, event)

  const lessonsFile = path.join(dir, 'lessons.json')
  assert.ok(fs.existsSync(lessonsFile), 'lessons.json 应已写入')
  const parsed = JSON.parse(fs.readFileSync(lessonsFile, 'utf8'))
  assert.equal(parsed.lessons.length, 1)
  assert.match(parsed.lessons[0].title, /python|PATH/i)

  // 会话 2（同项目）：context 渲染出简报
  const agent2 = fakeAgent('s2', 'E:\\dsh')
  ctx.emit('agent/created', { agent: agent2 })
  const text = renderBriefingOf(contexts, agent2)
  assert.match(text, /经验简报/)
  assert.match(text, /python|Python|运行时/i)

  // 工具查询
  const listTool = tools.find((tool) => tool.name === 'pitfall_list')
  const value = await listTool.execute({}, { agent: agent2 })
  assert.equal(value.total, 1)
  assert.equal(value.lessons.length, 1)
  ctx.disposeAll()
})

test('同一会话重复踩坑会提醒一次', async () => {
  const dir = tempDir('smoke-repeat')
  const { ctx, contexts } = fakeContext()
  apply(ctx, { storeDir: dir, repeatWarn: true, seed: false })

  const resumed = fakeAgent('s1', 'E:\\dsh')
  ctx.emit('agent/created', { agent: resumed })
  renderBriefingOf(contexts, resumed)

  const session = { id: 's1', header: { cwd: 'E:\\dsh' } }
  for (const event of failEvents()) ctx.emit('session/event', session, event)
  const session2 = { id: 's1', header: { cwd: 'E:\\dsh' } }
  for (const event of failEvents()) ctx.emit('session/event', session2, event)

  assert.equal(resumed.injected.length, 1, '同会话第二次踩坑应提醒')
  assert.match(resumed.injected[0].content[0].text, /第 2 次/)
  ctx.disposeAll()
})

test('种子经验首次写入，且不会重复写入', () => {
  const dir = tempDir('smoke-seed')
  const first = fakeContext()
  apply(first.ctx, { storeDir: dir })
  const file = path.join(dir, 'lessons.json')
  assert.ok(fs.existsSync(file), '种子应立即落盘')
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(parsed.lessons.length >= 10, `种子条数应足够，实际 ${parsed.lessons.length}`)
  assert.ok(parsed.lessons.every((lesson) => lesson.source === 'seed'))
  assert.ok(parsed.lessons.every((lesson) => lesson.projects.includes('*')))
  first.ctx.disposeAll()

  const second = fakeContext()
  apply(second.ctx, { storeDir: dir })
  const again = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(again.lessons.length, parsed.lessons.length, '已有经验时不应再写种子')
  second.ctx.disposeAll()
})

test('种子经验会渲染到 dynamic context', () => {
  const dir = tempDir('smoke-seed-inject')
  const { ctx, contexts } = fakeContext()
  apply(ctx, { storeDir: dir, maxLessons: 5 })
  const agent = fakeAgent('s1', 'E:\\dsh')
  ctx.emit('agent/created', { agent })
  const text = renderBriefingOf(contexts, agent)
  assert.match(text, /经验简报/)
  assert.match(text, /规则|python|沙箱/)
  ctx.disposeAll()
})

test('会话结束生成会话总结，日/周总结工具可用', async () => {
  const dir = tempDir('smoke-summary')
  const { ctx, tools } = fakeContext()
  apply(ctx, { storeDir: dir, seed: false })

  const agent = fakeAgent('s1', 'E:\\dsh')
  ctx.emit('agent/created', { agent })
  const session = { id: 's1', header: { cwd: 'E:\\dsh' } }
  for (const event of failEvents()) ctx.emit('session/event', session, event)
  ctx.emit('agent/disposed', { agent })

  const sessionDigest = path.join(dir, 'summaries', 'session-s1.md')
  assert.ok(fs.existsSync(sessionDigest), '会话总结应已生成')
  assert.match(fs.readFileSync(sessionDigest, 'utf8'), /会话总结/)

  const summaryTool = tools.find((tool) => tool.name === 'pitfall_summary')
  const day = await summaryTool.execute({ period: 'day' }, { agent })
  assert.equal(day.ok, true)
  assert.match(day.text, /日总结/)
  assert.ok(fs.existsSync(path.join(dir, 'summaries', `daily-${localDateKey(new Date())}.md`)))

  const week = await summaryTool.execute({ period: 'week' }, { agent })
  assert.equal(week.ok, true)
  assert.match(week.text, /周总结/)
  if (week.file) assert.ok(fs.existsSync(week.file), `周总结文件应存在：${week.file}`)

  ctx.disposeAll()
})
test('进程收尾时补写未完成的会话总结', async () => {
  const dir = tempDir('smoke-finalize')
  const { ctx } = fakeContext()
  apply(ctx, { storeDir: dir, seed: false })

  const agent = fakeAgent('s9', 'E:\dsh')
  ctx.emit('agent/created', { agent })
  const session = { id: 's9', header: { cwd: 'E:\dsh' } }
  for (const event of failEvents()) ctx.emit('session/event', session, event)

  // 不触发 agent/disposed，直接卸载插件（模拟进程退出/热重载）
  ctx.disposeAll()
  const digest = path.join(dir, 'summaries', 'session-s9.md')
  assert.ok(fs.existsSync(digest), '卸载时应补写会话总结')
  assert.match(fs.readFileSync(digest, 'utf8'), /会话总结/)
})
