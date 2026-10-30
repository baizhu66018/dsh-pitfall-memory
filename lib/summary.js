/**
 * 总结引擎：把零散经验收敛成「观察 → 经验 → 模式 → 规则」四层结构。
 *
 * 这是插件的“总结逻辑框架”：
 *   L1 观察（observation）  原始失败，带证据
 *   L2 经验（lesson）       同一签名归并后的「症状 + 正确做法」
 *   L3 模式（pattern）      按根因族聚合，回答“为什么总是这里出问题”
 *   L4 规则（rule）         从模式里压出的可执行短句，注入时最先展示
 *
 * 三级总结都复用这一框架：
 *   - 会话总结：本次会话的 L1 → L2，并标出新增/复发；
 *   - 日总结：当天所有会话的 L1 → L3，给出趋势；
 *   - 周总结：7 天的 L3 → L4，给出“该固化进 AGENTS.md 的规则”。
 */
import { CATEGORY_META } from './detect.js'
import { clip } from './util.js'

/** 根因族：比 category 更接近“为什么”。 */
export const ROOT_CAUSES = {
  'sandbox-boundary': {
    label: '沙箱边界',
    hint: '写工作区外路径、访问被隔离的目录',
    category: 'sandbox',
  },
  'restricted-token': {
    label: '受限令牌',
    hint: '管道、子进程、mkdtemp、pip 等依赖令牌权限的操作',
    category: 'sandbox',
  },
  'runtime-resolution': {
    label: '运行时解析',
    hint: 'PATH 上的占位符、命令不存在、版本不对',
    category: 'runtime',
  },
  'cjk-encoding': {
    label: '中文编码链路',
    hint: 'Python GBK、终端代码页、文件 BOM',
    category: 'encoding',
  },
  'network-credentials': {
    label: '网络与凭据',
    hint: 'schannel 凭据、被重置的域名、偶发超时',
    category: 'network',
  },
  'git-identity': {
    label: 'Git 身份与配置',
    hint: '全局 user.name/email 缺失、换行符策略',
    category: 'git',
  },
  'tool-contract': {
    label: '工具契约',
    hint: '工具名不可见、参数/输出 schema 不匹配',
    category: 'tooling',
  },
  'command-execution': {
    label: '命令执行',
    hint: '退出码非零、参数错误、串联命令未短路',
    category: 'command',
  },
  'path-length': {
    label: '路径长度',
    hint: '超过 260 字符，LongPathsEnabled=0',
    category: 'runtime',
  },
  unknown: {
    label: '未归类',
    hint: '还没有足够证据判断根因',
    category: 'command',
  },
}

/** 规则 → 根因族的映射（自动经验用 ruleId，种子/手动经验用 category 兜底）。 */
const RULE_TO_ROOT = {
  'python-placeholder': 'runtime-resolution',
  'python-pipe': 'restricted-token',
  'pip-locked': 'restricted-token',
  'mkdtemp-locked': 'restricted-token',
  'python-encoding': 'cjk-encoding',
  'dsh-home-write': 'sandbox-boundary',
  'npm-cache-denied': 'sandbox-boundary',
  'sandbox-denied': 'sandbox-boundary',
  'git-identity': 'git-identity',
  'schannel-https': 'network-credentials',
  'network-reset': 'network-credentials',
  'long-path': 'path-length',
  'unknown-tool': 'tool-contract',
  'tool-error': 'tool-contract',
  'command-not-found': 'runtime-resolution',
  'nonzero-exit': 'command-execution',
}

const CATEGORY_TO_ROOT = {
  sandbox: 'sandbox-boundary',
  runtime: 'runtime-resolution',
  encoding: 'cjk-encoding',
  network: 'network-credentials',
  git: 'git-identity',
  tooling: 'tool-contract',
  command: 'command-execution',
}

/** 一条经验属于哪个根因族。 */
export function rootCauseOf(lesson) {
  const byRule = RULE_TO_ROOT[lesson?.ruleId]
  if (byRule) return byRule
  const byCategory = CATEGORY_TO_ROOT[lesson?.category]
  return byCategory ?? 'unknown'
}

/** 把经验聚合成模式（按根因族）。 */
export function buildPatterns(lessons) {
  const groups = new Map()
  for (const lesson of lessons ?? []) {
    if (lesson.status !== 'active') continue
    const key = rootCauseOf(lesson)
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        ...(ROOT_CAUSES[key] ?? ROOT_CAUSES.unknown),
        lessons: [],
        occurrences: 0,
        lastSeen: '',
      })
    }
    const group = groups.get(key)
    group.lessons.push(lesson)
    group.occurrences += lesson.occurrences ?? 1
    if (!group.lastSeen || lesson.lastSeen > group.lastSeen) group.lastSeen = lesson.lastSeen
  }
  return [...groups.values()].sort((a, b) => b.occurrences - a.occurrences)
}

/** 从建议里压出一句可执行的规则（取首句，去掉冗余前缀）。 */
export function ruleLineOf(lesson) {
  const advice = String(lesson.advice ?? '').trim()
  if (advice === '') return ''
  const first = advice.split(/(?<=[。；;！!])/u)[0] ?? advice
  return clip(first.trim(), 140)
}

/**
 * 规则卡（L4）：注入时最前面的可执行清单。
 * 同一根因族最多取 2 条，避免整段被一个主题占满。
 */
export function buildRuleCards(lessons, { max = 8 } = {}) {
  const perRoot = new Map()
  const cards = []
  const ordered = [...(lessons ?? [])].sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity
    return (b.occurrences ?? 1) - (a.occurrences ?? 1)
  })
  for (const lesson of ordered) {
    if (lesson.status !== 'active') continue
    const line = ruleLineOf(lesson)
    if (line === '') continue
    const root = rootCauseOf(lesson)
    const used = perRoot.get(root) ?? 0
    if (used >= 2) continue
    perRoot.set(root, used + 1)
    cards.push({
      root,
      rootLabel: (ROOT_CAUSES[root] ?? ROOT_CAUSES.unknown).label,
      icon: (CATEGORY_META[lesson.category] ?? { icon: '•' }).icon,
      line,
      lessonId: lesson.id,
    })
    if (cards.length >= max) break
  }
  return cards
}

/**
 * 根因族的展示名：tooling 且 ruleId 是兜底时说明「工具执行失败」，
 * 不要笼统显示成「未归类」，否则每天的总结都在说「未归类最常见」。
 */
export function rootLabelFor(observation) {
  const key = RULE_TO_ROOT[observation?.ruleId] ?? 'unknown'
  if (key === 'unknown' && observation?.category === 'tooling') return '工具执行失败'
  return (ROOT_CAUSES[key] ?? ROOT_CAUSES.unknown).label
}

/** 会话总结：本次会话捕获了什么、哪些是新坑、哪些复发。 */
export function buildSessionDigest({ sessionId, project, at, startedAt = '', observations = [], touched = [] }) {
  const byRoot = new Map()
  for (const observation of observations) {
    const key = RULE_TO_ROOT[observation.ruleId] ?? 'unknown'
    if (!byRoot.has(key)) byRoot.set(key, { key, label: rootLabelFor(observation), count: 0 })
    byRoot.get(key).count += 1
  }
  // 新坑 = 首次出现时间落在本会话开始之后；其余算复发（不受会话内重复计数干扰）。
  const fresh = touched.filter((lesson) => startedAt === '' || (lesson.firstSeen ?? '') >= startedAt)
  const repeated = touched.filter((lesson) => !fresh.includes(lesson))
  return {
    kind: 'session',
    id: sessionId,
    project,
    at,
    observations: observations.length,
    distinct: touched.length,
    fresh: fresh.map(slim),
    repeated: repeated.map(slim),
    roots: [...byRoot.values()].sort((a, b) => b.count - a.count),
  }
}

function slim(lesson) {
  return {
    id: lesson.id,
    title: lesson.title,
    category: lesson.category,
    occurrences: lesson.occurrences,
    advice: clip(lesson.advice ?? '', 160),
  }
}

/** 日总结：当天所有会话的聚合。 */
export function buildDailyDigest({ date, observations = [], lessons = [], sessionDigests = [] }) {
  const rootMap = new Map()
  for (const observation of observations) {
    const key = RULE_TO_ROOT[observation.ruleId] ?? 'unknown'
    if (!rootMap.has(key)) {
      rootMap.set(key, { key, label: rootLabelFor(observation), count: 0 })
    }
    rootMap.get(key).count += 1
  }
  const roots = [...rootMap.values()].sort((a, b) => b.count - a.count)
  // 种子经验是「已知事实」，不算当天新踩的坑；手动补充的经验算。
  const fresh = lessons.filter(
    (lesson) => lesson.source !== 'seed' && (lesson.firstSeen ?? '').startsWith(date),
  )
  const repeated = lessons.filter(
    (lesson) => (lesson.lastSeen ?? '').startsWith(date) && !(lesson.firstSeen ?? '').startsWith(date),
  )
  const resolved = lessons.filter((lesson) => lesson.status === 'resolved')
  return {
    kind: 'daily',
    date,
    sessions: sessionDigests.length,
    observations: observations.length,
    distinctLessons: new Set(lessons.map((lesson) => lesson.id)).size,
    fresh: fresh.map(slim),
    repeated: repeated.map(slim),
    resolved: resolved.map(slim),
    roots,
    highlights: buildHighlights(roots, fresh, repeated),
  }
}

function buildHighlights(roots, fresh, repeated) {
  const lines = []
  if (roots[0]) lines.push(`${roots[0].label} 最常见（${roots[0].count} 次）`)
  if (fresh.length > 0) lines.push(`新增经验：${fresh.slice(0, 2).map((item) => item.title).join('、')}`)
  if (repeated.length > 0) {
    lines.push(`复发：${repeated.slice(0, 2).map((item) => `${item.title}（×${item.occurrences}）`).join('、')}`)
  }
  return lines
}

/** 周总结：7 天的模式 → 规则建议。 */
export function buildWeeklyDigest({ week, days = [], lessons = [] }) {
  const rootMap = new Map()
  let observations = 0
  for (const day of days) {
    observations += day.observations ?? 0
    for (const root of day.roots ?? []) {
      if (!rootMap.has(root.key)) rootMap.set(root.key, { ...root })
      else rootMap.get(root.key).count += root.count
    }
  }
  const roots = [...rootMap.values()].sort((a, b) => b.count - a.count)
  const recentFresh = lessons.filter(
    (lesson) => lesson.source !== 'seed' && lesson.firstSeen && lesson.firstSeen >= (days[0]?.date ?? ''),
  )
  const rules = recentFresh
    .sort((a, b) => (b.occurrences ?? 1) - (a.occurrences ?? 1))
    .slice(0, 5)
    .map((lesson) => ({
      title: lesson.title,
      rule: ruleLineOf(lesson),
      lessonId: lesson.id,
      category: lesson.category,
    }))
  return {
    kind: 'weekly',
    week,
    days: days.map((day) => day.date),
    observations,
    sessions: days.reduce((sum, day) => sum + (day.sessions ?? 0), 0),
    fresh: recentFresh.length,
    roots,
    rules,
  }
}

/** 渲染会话总结（Markdown）。 */
export function renderSessionDigest(digest) {
  const lines = [
    `# 会话总结 · ${digest.at.slice(0, 19).replace('T', ' ')}`,
    '',
    `- 会话：\`${digest.id}\``,
    `- 项目：${digest.project || '（未知）'}`,
    `- 捕获失败：${digest.observations} 条，涉及 ${digest.distinct} 条经验`,
    '',
  ]
  if (digest.observations === 0) {
    lines.push('本次会话没有捕获到工具失败。')
    return lines.join('\n')
  }
  lines.push('## 按根因族')
  lines.push('')
  for (const root of digest.roots) lines.push(`- ${root.label}：${root.count} 条`)
  lines.push('')
  if (digest.fresh.length > 0) {
    lines.push('## 新坑')
    lines.push('')
    for (const lesson of digest.fresh) lines.push(`- **${lesson.title}**：${lesson.advice}`)
    lines.push('')
  }
  if (digest.repeated.length > 0) {
    lines.push('## 复发的坑')
    lines.push('')
    for (const lesson of digest.repeated) lines.push(`- **${lesson.title}**（×${lesson.occurrences}）：${lesson.advice}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** 渲染日总结。 */
export function renderDailyDigest(digest) {
  const lines = [
    `# 日总结 · ${digest.date}`,
    '',
    `- 会话：${digest.sessions}`,
    `- 捕获失败：${digest.observations} 条`,
    `- 涉及经验：${digest.distinctLessons} 条（新增 ${digest.fresh.length}，复发 ${digest.repeated.length}）`,
    '',
  ]
  if (digest.observations === 0) {
    lines.push('今天没有捕获到工具失败。')
    return lines.join('\n')
  }
  lines.push('## 关键结论')
  lines.push('')
  for (const line of digest.highlights) lines.push(`- ${line}`)
  lines.push('')
  lines.push('## 根因族排行')
  lines.push('')
  for (const root of digest.roots) lines.push(`- ${root.label}：${root.count} 次`)
  lines.push('')
  if (digest.fresh.length > 0) {
    lines.push('## 新增经验')
    lines.push('')
    for (const lesson of digest.fresh) lines.push(`- ${lesson.title}：${lesson.advice}`)
    lines.push('')
  }
  if (digest.repeated.length > 0) {
    lines.push('## 复发')
    lines.push('')
    for (const lesson of digest.repeated) {
      lines.push(`- ${lesson.title}（×${lesson.occurrences}）：${lesson.advice}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** 渲染周总结。 */
export function renderWeeklyDigest(digest) {
  const lines = [
    `# 周总结 · ${digest.week}`,
    '',
    `- 覆盖：${digest.days.join('、') || '（无数据）'}`,
    `- 会话：${digest.sessions}　失败：${digest.observations} 条　新增经验：${digest.fresh} 条`,
    '',
    '## 根因族排行',
    '',
  ]
  for (const root of digest.roots) lines.push(`- ${root.label}：${root.count} 次`)
  if (digest.roots.length === 0) lines.push('- （本周没有失败记录）')
  lines.push('')
  lines.push('## 建议固化到 AGENTS.md 的规则')
  lines.push('')
  if (digest.rules.length === 0) lines.push('- （暂无）')
  for (const rule of digest.rules) lines.push(`- **${rule.title}**：${rule.rule}`)
  lines.push('')
  return lines.join('\n')
}

/** 把日/周总结压成注入用的短摘要。 */
export function briefingFromDigest(digest) {
  if (!digest) return []
  if (digest.kind === 'daily') return (digest.highlights ?? []).slice(0, 3)
  if (digest.kind === 'weekly') {
    return (digest.roots ?? []).slice(0, 3).map((root) => `本周 ${root.label} ${root.count} 次`)
  }
  return []
}