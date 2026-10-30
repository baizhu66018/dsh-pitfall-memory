/**
 * 给模型用的工具：查看/补充/标记经验，以及复盘当前会话。
 *
 * 工具定义刻意用原始 JSON Schema（不依赖 dsh-tools 的 defineTool），
 * 这样插件在没有任何 peer dependency 的情况下也能注册。
 */
import { CATEGORY_META, classify, textOfBlocks } from './detect.js'
import { renderLessonDetail } from './render.js'
import { localDateKey, localWeekKey, weekDates } from './rollups.js'
import {
  buildPatterns,
  buildSessionDigest,
  renderDailyDigest,
  renderSessionDigest,
  renderWeeklyDigest,
} from './summary.js'
import { clip } from './util.js'

const TEXT = (text) => [{ type: 'text', text }]

/** 空对象输出 schema：所有工具都返回任意 JSON 对象。 */
const OBJECT_OUTPUT = { type: 'object', additionalProperties: true }

export function createPitfallTools({ store, config, book, sessionState }) {
  /** 当前调用者的会话 id 与项目（拿不到就退化为全局）。 */
  function callerOf(exec) {
    const agent = exec?.agent
    const session = agent?.session
    const sessionId = session?.id ?? agent?.id ?? ''
    const cwd = session?.header?.cwd ?? ''
    const project = sessionState.projectFor(sessionId, cwd)
    return { sessionId: String(sessionId ?? ''), project }
  }

  return [
    {
      name: 'pitfall_list',
      description:
        '列出踩坑经验库中的经验（默认只列活跃的、与当前项目相关的）。用 category/status 过滤；scope=all 可看所有项目。',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'resolved', 'muted', 'all'],
            description: '按状态过滤，默认 active。',
          },
          category: {
            type: 'string',
            enum: Object.keys(CATEGORY_META),
            description: '按类别过滤。',
          },
          scope: {
            type: 'string',
            enum: ['current', 'all'],
            description: 'current=只看当前项目与全局经验（默认）；all=所有项目。',
          },
          limit: { type: 'integer', description: '最多返回多少条，默认 20，上限 100。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: OBJECT_OUTPUT,
        render(_args, value) {
          const lines = [
            `共 ${value.total} 条经验（显示 ${value.lessons.length} 条）`,
            value.storeFile ? `库文件：${value.storeFile}` : '',
            '',
          ]
          for (const lesson of value.lessons) {
            const meta = CATEGORY_META[lesson.category] ?? { label: lesson.category, icon: '•' }
            lines.push(
              `${meta.icon} ${lesson.title}（${lesson.id}｜${lesson.status}｜×${lesson.occurrences}｜最近 ${lesson.lastSeen}）`,
              `  症状：${clip(lesson.symptom, 180)}`,
              `  做法：${clip(lesson.advice, 240)}`,
            )
          }
          if (value.lessons.length === 0) lines.push('（没有匹配的经验）')
          return TEXT(lines.filter((line) => line !== undefined).join('\n'))
        },
      },
      async execute(args, exec) {
        const { project } = callerOf(exec)
        const scopeAll = args?.scope === 'all'
        const rows = store.list({
          status: args?.status ?? 'active',
          category: args?.category,
          project,
          projectScoped: !scopeAll,
          limit: Math.min(100, Math.max(1, Number(args?.limit) || 20)),
        })
        return {
          total: store.lessons.length,
          storeFile: store.file,
          lessons: rows.map((lesson) => ({
            id: lesson.id,
            title: lesson.title,
            category: lesson.category,
            status: lesson.status,
            occurrences: lesson.occurrences,
            lastSeen: lesson.lastSeen,
            symptom: lesson.symptom,
            advice: lesson.advice,
          })),
        }
      },
    },

    {
      name: 'pitfall_remember',
      description:
        '把一条本次会话总结出的经验写进踩坑库（同一条经验重复记录会更新）。适合在收尾时把「根因 + 正确做法」补成人话，供后续会话注入。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '一句话标题，例如「写 DSH_HOME 必被沙箱拒绝」。' },
          symptom: { type: 'string', description: '症状/报错原文（可截断），让人能认出这是同一个坑。' },
          advice: { type: 'string', description: '下次的正确做法，要具体可执行。' },
          category: {
            type: 'string',
            enum: Object.keys(CATEGORY_META),
            description: '类别，默认 tooling。',
          },
          scope: {
            type: 'string',
            enum: ['project', 'global'],
            description: 'project=只在本项目注入（默认）；global=所有项目都注入。',
          },
          signature: {
            type: 'string',
            description: '可选：指定签名以覆盖/合并已自动记录的同一条经验（可从 pitfall_list 拿到）。',
          },
        },
        required: ['title', 'symptom', 'advice'],
        additionalProperties: false,
      },
      output: {
        schema: OBJECT_OUTPUT,
        render(_args, value) {
          return TEXT(value.ok ? `已记录：\n${value.lesson}` : `记录失败：${value.error}`)
        },
      },
      async execute(args, exec) {
        const title = String(args?.title ?? '').trim()
        const symptom = String(args?.symptom ?? '').trim()
        const advice = String(args?.advice ?? '').trim()
        if (title === '' || symptom === '' || advice === '') {
          return { ok: false, error: 'title / symptom / advice 都必须是非空字符串。' }
        }
        const { project } = callerOf(exec)
        const lesson = store.remember({
          title,
          symptom,
          advice,
          category: args?.category ?? 'tooling',
          scope: args?.scope === 'global' ? 'global' : 'project',
          project,
          signature: typeof args?.signature === 'string' && args.signature.trim() !== '' ? args.signature.trim() : '',
        })
        store.save()
        return { ok: true, lesson: renderLessonDetail(lesson) }
      },
    },

    {
      name: 'pitfall_resolve',
      description:
        '把一条经验标记为已解决（resolved）或忽略（muted），或重新激活（active）。已解决的经验不再注入；若同样的坑再次出现会自动复活。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '经验 id 或签名（pitfall_list 里可拿到）。' },
          status: {
            type: 'string',
            enum: ['resolved', 'muted', 'active'],
            description: '目标状态，默认 resolved。',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        schema: OBJECT_OUTPUT,
        render(_args, value) {
          return TEXT(value.ok ? `已更新：\n${value.lesson}` : `更新失败：${value.error}`)
        },
      },
      async execute(args) {
        const id = String(args?.id ?? '').trim()
        if (id === '') return { ok: false, error: 'id 不能为空。' }
        const status = args?.status ?? 'resolved'
        const lesson = store.setStatus(id, status)
        if (!lesson) return { ok: false, error: `没有找到经验：${id}` }
        store.save()
        return { ok: true, lesson: renderLessonDetail(lesson) }
      },
    },

    {
      name: 'pitfall_review',
      description:
        '复盘当前（或最近一次）会话里的工具失败：按类别汇总症状、对照经验库中的历史次数，给出「新坑 / 重复坑 / 已解决又复发」的判断，便于收尾时用 pitfall_remember 补经验。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '最多列多少条失败，默认 20。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: OBJECT_OUTPUT,
        render(_args, value) {
          return TEXT(value.text)
        },
      },
      async execute(args, exec) {
        const { sessionId } = callerOf(exec)
        const limit = Math.min(100, Math.max(1, Number(args?.limit) || 20))
        const session = exec?.agent?.session
        const observations = sessionId && session ? scanSession(session, limit) : []
        const lines = []
        lines.push(`## 本次会话失败复盘（${observations.length} 条）`)
        lines.push('')
        const patterns = buildPatterns(store.lessons).slice(0, 3)
        if (patterns.length > 0) {
          lines.push(`库内根因族：${patterns.map((item) => `${item.label}(${item.occurrences})`).join('、')}`)
          lines.push('')
        }
        if (observations.length === 0) {
          lines.push('本次会话没有捕获到工具失败。')
        }
        const groups = new Map()
        for (const obs of observations) {
          const key = obs.signature
          if (!groups.has(key)) groups.set(key, { obs, count: 0 })
          groups.get(key).count += 1
        }
        for (const [signature, group] of groups) {
          const lesson = store.lessons.find((item) => item.signature === signature)
          const history = lesson ? lesson.occurrences : 0
          const verdict = lesson
            ? lesson.status === 'resolved'
              ? '⚠️ 已标记解决但又复发'
              : `↺ 重复坑（历史 ${history} 次）`
            : '🆕 新坑（尚未入库）'
          lines.push(`### ${group.obs.title}　×${group.count}`)
          lines.push(`- 判定：${verdict}`)
          lines.push(`- 工具：${group.obs.toolName || '（未知）'}`)
          if (group.obs.command) lines.push(`- 触发：\`${clip(group.obs.command, 160)}\``)
          lines.push(`- 症状：${clip(group.obs.symptom, 240)}`)
          lines.push(`- 建议：${clip(group.obs.advice, 240)}`)
          lines.push('')
        }
        lines.push('如需把复盘结论固化，请调用 `pitfall_remember`（title/symptom/advice）。')
        return { text: lines.join('\n'), observations: observations.length }
      },
    },

    {
      name: 'pitfall_summary',
      description:
        '生成/查看总结：session=本次会话，day=今天，week=本周。总结按「观察→经验→模式→规则」四层收敛，日/周总结会写到 summaries/ 目录。',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['auto', 'session', 'day', 'week'],
            description: 'auto=有会话则总结会话；默认 auto。',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: OBJECT_OUTPUT,
        render(_args, value) {
          return TEXT(value.text)
        },
      },
      async execute(args, exec) {
        if (!book) return { ok: false, error: '总结模块未初始化。' }
        const period = args?.period ?? 'auto'
        const { sessionId, project } = callerOf(exec)

        if (period === 'session' || (period === 'auto' && sessionId !== '')) {
          const session = exec?.agent?.session
          const observations = session ? scanSession(session, 200) : []
          const touched = []
          const seen = new Set()
          for (const observation of observations) {
            const lesson = store.lessons.find((item) => item.signature === observation.signature)
            if (lesson && !seen.has(lesson.id)) {
              seen.add(lesson.id)
              touched.push(lesson)
            }
          }
          const digest = buildSessionDigest({
            sessionId,
            project,
            at: new Date().toISOString(),
            observations,
            touched,
          })
          return { ok: true, period: 'session', file: '', text: renderSessionDigest(digest) }
        }

        if (period === 'day') {
          const date = localDateKey(new Date())
          const digest = book.refreshDaily(date)
          if (!digest) return { ok: true, period: 'day', file: '', text: `今天（${date}）还没有捕获到失败。` }
          return {
            ok: true,
            period: 'day',
            file: `${book.summariesDir}/daily-${date}.md`,
            text: renderDailyDigest(digest),
          }
        }

        if (period === 'week') {
          const week = localWeekKey(new Date())
          for (const date of weekDates(week)) book.refreshDaily(date)
          const digest = book.refreshWeekly(week)
          if (!digest) return { ok: true, period: 'week', file: '', text: `本周（${week}）还没有可汇总的日总结。` }
          return {
            ok: true,
            period: 'week',
            file: `${book.summariesDir}/weekly-${week}.md`,
            text: renderWeeklyDigest(digest),
          }
        }

        return { ok: false, error: `未知周期：${period}` }
      },
    },
  ]
}

/** 重新扫描会话日志中的失败（不写库，避免重复计数）。 */
function scanSession(session, limit) {
  const calls = new Map()
  const found = []
  for (const event of session.events ?? []) {
    if (event.type === 'tool/call') {
      let args = {}
      try {
        args = JSON.parse(event.data.arguments ?? '{}')
      } catch {
        /* 参数可能不是合法 JSON，忽略 */
      }
      calls.set(event.data.callId, { name: event.data.name, args })
      continue
    }
    if (event.type !== 'tool/result') continue
    const block = event.data?.message?.content?.[0]
    if (!block) continue
    const call = calls.get(block.toolCallId) ?? {}
    const obs = classify({
      toolName: call.name ?? 'tool',
      command: typeof call.args?.command === 'string' ? call.args.command : '',
      text: textOfBlocks(block.content),
      isError: Boolean(block.isError),
      errorInfo: event.data?.error,
    })
    if (obs) found.push(obs)
    if (found.length >= limit) break
  }
  return found
}