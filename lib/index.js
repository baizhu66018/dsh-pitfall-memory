/**
 * dsh-pitfall-memory —— 踩坑记忆插件。
 *
 * 目标：每次会话里工具调用失败时自动捕获，归纳成可复用的经验；
 * 后续会话开始时把经验简报注入模型上下文，避免重复踩同一个坑。
 *
 * 总结框架（四层收敛）：
 *   L1 观察 → L2 经验 → L3 模式（根因族）→ L4 规则（可执行清单）
 * 三级总结：
 *   每次会话（session digest）→ 每天（daily digest）→ 每周（weekly digest）
 *
 * 工作方式（全部走公开契约，不碰宿主内部实现）：
 * 1. 监听 `session/event`，从 `tool/call` + `tool/result` 配对出「失败观察」；
 * 2. `turn/end` 时把观察合并进本 profile 下的经验库（JSON + NDJSON 证据）；
 * 3. 监听 `agent/pre-step`，在本会话第一次模型请求前把「经验简报」放进消息
 *    （用 waterfall 返回新 messages；每个进程每个会话必注入一次，不依赖历史）；
 * 4. `agent/disposed` 时生成会话总结，并按天/周补生成日总结与周总结；
 * 5. 注册 pitfall_* 工具，允许模型查看、补充、标记经验与总结。
 *
 * 可观测性：apply 与 pre-step 的关键决策写入 `<store>/.heartbeat.jsonl`，
 * 这样“插件到底加载了没有 / 为什么没注入”不用靠猜。
 *
 * 失败隔离：apply 主体包 try/catch；事件回调各自 try/catch，绝不影响会话。
 */
import fs from 'node:fs'
import path from 'node:path'

import { resolveConfig } from './config.js'
import { classify, textOfBlocks } from './detect.js'
import { renderBriefing, renderLessonsMarkdown, renderRepeatWarn } from './render.js'
import { SummaryBook, localDateKey } from './rollups.js'
import { seedLessons } from './seed.js'
import { API_PREFIX, createApi, mountApi } from './settings-api.js'
import { PitfallStore } from './store.js'
import { buildRuleCards } from './summary.js'
import { createPitfallTools } from './tools.js'
import { clip, errorText, projectKeyOf, projectLabel, resolveProfileDir, sha1 } from './util.js'

/** Cordis 插件名（加载器诊断用）。 */
export const name = 'pitfall-memory'

/** 依赖工具运行时（注册 pitfall_* 工具）；systemPrompt 用 ctx.inject 按需等待。 */
export const inject = ['tools']

const PLUGIN = 'dsh-pitfall-memory'
const VERSION = '0.4.0'
const SUMMARY_MAX = 120

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const dir =
    config.storeDir !== '' ? path.resolve(config.storeDir) : path.join(resolveProfileDir(ctx), '.dsh-pitfall-memory')

  const beat = (event, detail = {}) => {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, '.heartbeat.jsonl')
      try {
        if (fs.statSync(file).size > 256 * 1024) fs.renameSync(file, `${file}.1`)
      } catch {
        /* 文件还不存在 */
      }
      fs.appendFileSync(
        file,
        `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, version: VERSION, event, ...detail })}\n`,
        'utf8',
      )
    } catch {
      /* 心跳失败不能反过来影响插件 */
    }
  }

  beat('apply-enter', { enabled: config.enabled })

  if (!config.enabled) {
    log(ctx, 'info', '行配置 enabled: false，插件不动作')
    beat('apply-disabled')
    return
  }

  try {
    applyInner(ctx, config, dir, beat)
    beat('apply-ok')
  } catch (error) {
    beat('apply-error', {
      message: clip(String(error?.message ?? error), 500),
      stack: clip(String(error?.stack ?? ''), 2000),
    })
    throw error
  }
}

function applyInner(ctx, config, dir, beat) {
  const store = new PitfallStore({
    dir,
    config,
    onPersist: (instance) => {
      try {
        const markdown = renderLessonsMarkdown(instance.lessons, {
          updatedAt: instance.updatedAt,
          dir: instance.dir,
        })
        fs.writeFileSync(path.join(instance.dir, 'lessons.md'), markdown, 'utf8')
      } catch (error) {
        debug(ctx, `写 lessons.md 失败：${errorText(error)}`)
      }
    },
  })

  // 首次运行：写入本机已知坑的种子经验，让第一次会话就有东西可用。
  if (config.seed) {
    try {
      const seeded = store.seedIfEmpty(seedLessons())
      if (seeded > 0) log(ctx, 'info', `已写入 ${seeded} 条种子经验`)
    } catch (error) {
      log(ctx, 'warn', `写入种子经验失败：${errorText(error)}`)
    }
  }

  const book = new SummaryBook({ dir, store, config })

  /** sessionId → 会话进行中的状态。 */
  const sessions = new Map()
  /** sessionId → agent（重复提醒要往正在运行的会话里 inject）。 */
  const agents = new Map()
  /** 本进程内已经注入过简报的会话。 */
  const injectedSessions = new Set()
  /** 日/周总结的懒触发节流（每天一次）。 */
  let lastEnsureDay = ''

  function ensureRollups() {
    if (!config.summaries) return
    const today = localDateKey(new Date())
    if (today === lastEnsureDay) return
    lastEnsureDay = today
    try {
      const checks = book.ensure()
      if (checks.length > 0) {
        debug(ctx, `补生成周期总结：${checks.map(([kind, key]) => `${kind}:${key}`).join(', ')}`)
        beat('rollups', { checks: checks.map(([kind, key]) => `${kind}:${key}`) })
      }
    } catch (error) {
      debug(ctx, `周期总结失败：${errorText(error)}`)
    }
  }

  function projectFor(sessionId, cwd) {
    const id = String(sessionId ?? '')
    if (id === '') return projectKeyOf(cwd)
    const state = sessions.get(id)
    if (state?.project) return state.project
    const project = projectKeyOf(cwd)
    if (state) state.project = project
    return project
  }

  function stateFor(session) {
    const id = String(session.id)
    let state = sessions.get(id)
    if (!state) {
      state = {
        startedAt: new Date().toISOString(),
        project: projectKeyOf(session.header?.cwd ?? ''),
        failures: [],
        digestObservations: [],
        digestLessons: new Map(),
        calls: new Map(),
        warned: new Set(),
        repeatCounts: new Map(),
        warns: 0,
      }
      sessions.set(id, state)
    }
    return state
  }

  /** 把本 turn 累积的失败落库，并留下会话总结的素材。 */
  function flush(state, sessionId) {
    if (!state || state.failures.length === 0) return
    const observations = state.failures
    state.failures = []
    try {
      const touched = store.addObservations(observations, {
        project: state.project,
        sessionId: String(sessionId ?? ''),
      })
      // turn 边界频率低，直接落盘：会话中途退出也不丢经验。
      store.save()
      for (const observation of observations) state.digestObservations.push(observation)
      for (const lesson of touched) state.digestLessons.set(lesson.id, lesson)
      beat('captured', { session: String(sessionId ?? ''), observations: observations.length, lessons: touched.length })
      debug(ctx, `捕获 ${observations.length} 条失败，合并为 ${touched.length} 条经验`)
    } catch (error) {
      log(ctx, 'warn', `写入经验库失败：${errorText(error)}`)
    }
  }

  // ── 捕获：会话日志里的工具失败 ────────────────────────────────────────

  ctx.on('session/event', (session, event) => {
    try {
      if (!config.capture && !config.repeatWarn) return
      if (event.type !== 'tool/call' && event.type !== 'tool/result' && event.type !== 'turn/end') return
      // 新会话（或 resume 后）第一次见到事件时，用会话自己的 header 定项目。
      const state = stateFor(session)
      if (event.type === 'turn/end') {
        flush(state, session.id)
        return
      }
      if (event.type === 'tool/call') {
        if (state.calls.size > 400) state.calls.clear()
        state.calls.set(event.data.callId, {
          name: event.data.name,
          args: parseArgs(event.data.arguments),
        })
        return
      }
      const block = event.data?.message?.content?.[0]
      if (!block) return
      // 结果可能跨 turn 到达、也可能 calls 被清过；退回到结果自带的 toolName。
      const call = state.calls.get(block.toolCallId) ?? {}
      const toolName = String(call.name ?? event.data?.message?.source?.toolName ?? 'tool')
      const resultText = textOfBlocks(block.content)
      if (config.captureTools.length > 0 && !config.captureTools.includes(toolName)) return
      const observation = classify({
        toolName,
        command: typeof call.args?.command === 'string' ? call.args.command : '',
        text: resultText,
        isError: Boolean(block.isError),
        errorInfo: event.data?.error,
      })
      if (!observation) return
      // 结果为空时补一条可辨认的症状，别让经验只有「（无输出）」。
      if (observation.symptom === '（无输出）') {
        observation.symptom = `${toolName} ${block.isError ? '返回 isError' : '调用失败'}，无输出内容（callId=${block.toolCallId}）`
      }

      if (config.capture && state.failures.length < config.maxFindingsPerSession) {
        state.failures.push(observation)
      }
      maybeWarnRepeat(session.id, state, observation)
    } catch (error) {
      debug(ctx, `session/event 处理失败：${errorText(error)}`)
    }
  })

  /** 同一签名在本会话重复出现时，提醒一次（最多 3 条，避免刷屏）。 */
  function maybeWarnRepeat(sessionId, state, observation) {
    if (!config.repeatWarn) return
    const times = (state.repeatCounts.get(observation.signature) ?? 0) + 1
    state.repeatCounts.set(observation.signature, times)
    if (times !== 2 || state.warned.has(observation.signature) || state.warns >= 3) return
    const lesson = store.lessons.find((item) => item.signature === observation.signature) ?? null
    const agent = agents.get(String(sessionId))
    if (!agent || typeof agent.inject !== 'function') return
    const text = lesson
      ? renderRepeatWarn(lesson, times)
      : `⚠️ 同一类失败本会话已出现第 ${times} 次：${observation.title}。症状：${clip(observation.symptom, 200)}。做法：${clip(observation.advice, 240)}`
    try {
      agent.inject(makeNotice(text, `重复踩坑提醒：${clip(observation.title, 80)}`))
      state.warned.add(observation.signature)
      state.warns += 1
      beat('repeat-warn', { session: String(sessionId), signature: observation.signature })
    } catch (error) {
      debug(ctx, `重复提醒注入失败：${errorText(error)}`)
    }
  }

  // ── 注入：把经验简报挂成每轮必渲染的 dynamic context ──────────────────
  //
  // 用 systemPrompt.context（官方 sandbox-policy / user-approval / subagent 都走它），
  // 而不是 agent/pre-step 返回 messages：后者构造了也不一定被主循环采纳，
  // 实测「心跳记录了注入但会话日志里没有消息」。dynamic context 由宿主在
  // 每次装配时读取，会随「Current runtime context」快照一起进入模型请求，
  // 早装晚装、重启恢复都成立。

  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'pitfall:briefing',
      order: 950,
      text: (context) => {
        try {
          if (!config.inject) return ''
          const session = context?.agent?.session
          if (!session) return ''
          if (!config.injectIntoSubagents && session.header?.parentSession) return ''
          ensureRollups()
          const text = buildBriefingText(session)
          if (text === '') return ''
          const id = String(session.id)
          if (!injectedSessions.has(id)) {
            injectedSessions.add(id)
            beat('context-render', { session: id, chars: text.length })
          }
          return text
        } catch (error) {
          beat('context-error', { message: clip(String(error?.message ?? error), 500) })
          debug(ctx, `组装经验简报失败：${errorText(error)}`)
          return ''
        }
      },
    })
  })

  function buildBriefingText(session) {
    const project = projectFor(session.id, session.header?.cwd ?? '')
    const lessons = store.forInjection(project)
    if (lessons.length === 0) return ''
    const rendered = renderBriefing({
      rules: buildRuleCards(lessons, { max: 8 }),
      daily: book.latestDaily(),
      weekly: book.latestWeekly(),
      lessons,
      projectLabel: projectLabel(project),
      storeFile: store.file,
      maxBytes: config.maxInjectBytes,
      maxLessons: config.maxLessons,
    })
    return rendered.text
  }

  // ── 会话生命周期：映射、总结、清理 ────────────────────────────────────

  ctx.on('agent/created', ({ agent }) => {
    try {
      if (agent?.session?.id) agents.set(String(agent.session.id), agent)
    } catch {
      /* ignore */
    }
  })

  ctx.on('agent/session-start', () => {
    // 会话一开始就补齐昨天的日总结 / 上周的周总结，不必等下一次 pre-step。
    ensureRollups()
  })

  ctx.on('agent/disposed', ({ agent }) => {
    try {
      if (!agent?.session?.id) return
      const id = String(agent.session.id)
      agents.delete(id)
      injectedSessions.delete(id)
      const state = sessions.get(id)
      if (!state) return
      const digest = finalizeSession(id, state)
      if (digest) beat('session-digest', { session: id, observations: digest.observations })
      ensureRollups()
    } catch (error) {
      debug(ctx, `agent/disposed 处理失败：${errorText(error)}`)
    }
  })

  /**
   * 收尾一个会话：落库 → 写会话总结 → 刷新日总结 → 清状态。
   * @returns {object|undefined} 生成的会话总结（没有失败时为 undefined）
   */
  function finalizeSession(id, state) {
    flush(state, id)
    let digest
    if (config.summaries && state.digestObservations.length > 0) {
      try {
        digest = book.recordSession({
          sessionId: id,
          project: state.project,
          startedAt: state.startedAt,
          observations: state.digestObservations,
          touched: [...state.digestLessons.values()],
        })
        book.refreshDaily(localDateKey(new Date()))
      } catch (error) {
        debug(ctx, `写会话总结失败：${errorText(error)}`)
      }
    }
    sessions.delete(id)
    return digest
  }

  // ── 设置页后端：普通 HTTP 接口，供 client 半身读取 ────────────────────

  ctx.inject(['webServer'], (hostCtx) => {
    try {
      const api = createApi({ store, book, config })
      const disposers = mountApi({ webServer: hostCtx.webServer, api })
      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 单个路由卸载失败不影响其余 */
          }
        }
      }, `${PLUGIN}: settings api`)
      beat('settings-api-mounted', { prefix: API_PREFIX })
      log(ctx, 'info', `设置页接口已挂载：${API_PREFIX}`)
    } catch (error) {
      // 没有 webServer（headless/tui）时不影响插件本体。
      beat('settings-api-skip', { message: clip(String(error?.message ?? error), 300) })
      debug(ctx, `设置页接口未挂载：${errorText(error)}`)
    }
  })

  // ── 工具：pitfall_list / remember / resolve / review / summary ─────────

  const definitions = createPitfallTools({
    store,
    config,
    book,
    sessionState: { projectFor },
  })
  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register(definition), `${PLUGIN}: ${definition.name}`)
  }
  beat('tools-registered', { names: definitions.map((definition) => definition.name) })

  // ── 收尾 ──────────────────────────────────────────────────────────────

  ctx.effect(
    () => () => {
      // 进程退出/插件卸载时，把还没收尾的会话一并总结掉（agent/disposed 不一定来得及触发）。
      for (const [sessionId, state] of [...sessions]) {
        try {
          finalizeSession(sessionId, state)
        } catch (error) {
          debug(ctx, `收尾会话 ${sessionId} 失败：${errorText(error)}`)
        }
      }
      sessions.clear()
      agents.clear()
      injectedSessions.clear()
      store.close()
      beat('disposed')
    },
    `${PLUGIN}: flush & close`,
  )

  log(ctx, 'info', `已启用 v${VERSION}，经验库目录：${dir}`)
}

/** 构造一条 plugin notice 消息（agent.inject / pre-step 都要求完整 UserMessage）。 */
function makeNotice(text, summary) {
  return {
    id: `pm-${sha1(text).slice(0, 12)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: PLUGIN,
      form: 'notice',
      summary: clip(summary, SUMMARY_MAX),
    },
  }
}

function parseArgs(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function log(ctx, level, message) {
  const line = `[${PLUGIN}] ${message}`
  try {
    const logger = ctx?.logger
    const sink = logger?.[level]
    if (typeof sink === 'function') {
      sink.call(logger, line)
      return
    }
  } catch {
    /* ignore */
  }
  if (level === 'warn' || level === 'error') console.warn(line)
  else console.log(line)
}

function debug(ctx, message) {
  const logger = ctx?.logger
  try {
    if (logger && typeof logger.debug === 'function') {
      logger.debug(`[${PLUGIN}] ${message}`)
      return
    }
  } catch {
    /* ignore */
  }
  if (process.env.DSH_PITFALL_DEBUG === '1') console.log(`[${PLUGIN}] ${message}`)
}