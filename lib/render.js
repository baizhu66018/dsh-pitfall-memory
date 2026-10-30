/**
 * 渲染：把结构化经验变成模型可读（注入段落）与人可读（lessons.md）两种文本。
 * 纯函数，便于测试。
 */
import { clip } from './util.js'
import { CATEGORY_META } from './detect.js'
import { briefingFromDigest, buildRuleCards, rootCauseOf, ROOT_CAUSES } from './summary.js'

const CATEGORY_FALLBACK = { label: '其他', icon: '•' }

function metaOf(category) {
  return CATEGORY_META[category] ?? CATEGORY_FALLBACK
}

function countSuffix(lesson) {
  return lesson.occurrences > 1 ? `（×${lesson.occurrences}）` : ''
}

/**
 * 生成注入到会话开头的段落。
 * @param {object[]} lessons 已排序的经验
 * @param {object} options
 * @param {string} [options.projectLabel] 当前项目名
 * @param {number} [options.maxLessons] 条数上限
 * @param {number} [options.maxBytes] UTF-8 字节上限
 * @param {string} [options.storeFile] 完整清单路径（附在末尾）
 * @returns {{text: string, count: number}}
 */
export function renderInjection(lessons, options = {}) {
  const maxLessons = Math.max(1, options.maxLessons ?? 12)
  const maxBytes = Math.max(400, options.maxBytes ?? 6000)
  const selected = (lessons ?? []).slice(0, maxLessons)
  if (selected.length === 0) return { text: '', count: 0 }

  const project = options.projectLabel ? ` · 项目 ${options.projectLabel}` : ''
  const header =
    `## 🕳️ 本机踩坑经验（dsh-pitfall-memory 自动注入${project}）\n\n` +
    '以下是此前会话中真实发生过的失败及其正确做法。命中对应场景时直接按「做法」执行，不要原样重试已知会失败的路径。\n'
  const footer = options.storeFile
    ? `\n（完整清单：${options.storeFile}；可用 pitfall_list 查看，pitfall_remember 补充新经验。）`
    : ''

  let text = header
  let count = 0
  for (const lesson of selected) {
    const meta = metaOf(lesson.category)
    const full =
      `\n${count + 1}. ${meta.icon} ${lesson.title}${countSuffix(lesson)}\n` +
      `   症状：${clip(lesson.symptom || '（无记录）', 220)}\n` +
      `   做法：${clip(lesson.advice || '（未总结）', 320)}\n`
    if (fits(text + full + footer, maxBytes)) {
      text += full
      count += 1
      continue
    }
    // 第一条就放不下时退化为一句话版本：宁可窄一点，也不能整段丢掉。
    if (count === 0) {
      const room = maxBytes - Buffer.byteLength(text + footer, 'utf8')
      const compact =
        `\n1. ${meta.icon} ${lesson.title}${countSuffix(lesson)}\n` +
        `   做法：${clip(lesson.advice || '（未总结）', 320)}\n`
      const shortened = truncateToBytes(compact, room)
      if (shortened.trim() !== '') {
        text += shortened
        count += 1
      }
    }
    break
  }

  if (count === 0) return { text: '', count: 0 }
  const omitted = selected.length - count
  if (omitted > 0) {
    text += `\n（还有 ${omitted} 条经验因长度限制未展开。）\n`
  }
  text += footer
  return { text, count }
}

/**
 * 经验简报（新的注入格式）：规则卡 → 最近一天 → 本周模式 → 高频坑。
 *
 * 比逐条罗列经验更短、更有结构：规则卡是 L4，日/周摘要是 L3，高频坑是 L2。
 * @param {object} options
 * @param {object[]} [options.rules] buildRuleCards 的结果
 * @param {object|null} [options.daily] 最近一份日总结 JSON
 * @param {object|null} [options.weekly] 最近一份周总结 JSON
 * @param {object[]} [options.lessons] 活跃经验（按优先级排序）
 * @param {string} [options.projectLabel]
 * @param {string} [options.storeFile]
 * @param {number} [options.maxBytes]
 * @param {number} [options.maxLessons]
 * @returns {{text: string, sections: number}}
 */
export function renderBriefing(options = {}) {
  const maxBytes = Math.max(400, options.maxBytes ?? 6000)
  const maxLessons = Math.max(1, options.maxLessons ?? 8)
  const rules = options.rules ?? []
  const lessons = options.lessons ?? []
  const project = options.projectLabel ? ` · 项目 ${options.projectLabel}` : ''

  const blocks = []
  blocks.push(
    `## 🕳️ 本机经验简报（dsh-pitfall-memory${project}）\n\n` +
      '先读「规则」，命中场景直接照做；不要原样重试已知会失败的路径。',
  )

  if (rules.length > 0) {
    blocks.push(
      '### 先照做的规则\n\n' +
        rules.map((rule) => `- ${rule.icon} ${rule.line}`).join('\n'),
    )
  }

  const dailyLines = briefingFromDigest(options.daily)
  if (dailyLines.length > 0) {
    blocks.push(`### 最近一天（${options.daily.date}）\n\n${dailyLines.map((line) => `- ${line}`).join('\n')}`)
  }

  const weeklyLines = briefingFromDigest(options.weekly)
  if (weeklyLines.length > 0) {
    blocks.push(`### 本周模式\n\n${weeklyLines.map((line) => `- ${line}`).join('\n')}`)
  }

  // 规则已经覆盖到的经验不再重复列一遍，避免同一句话出现两次。
  const ruleIds = new Set(rules.map((rule) => rule.lessonId))
  const rest = lessons.filter((lesson) => !ruleIds.has(lesson.id))
  if (rest.length > 0) {
    const lines = rest.slice(0, maxLessons).map((lesson) => {
      const meta = metaOf(lesson.category)
      return `- ${meta.icon} ${lesson.title}${countSuffix(lesson)}：${clip(lesson.advice || '（未总结）', 150)}`
    })
    blocks.push(`### 其他高频坑\n\n${lines.join('\n')}`)
  }

  const footer = options.storeFile
    ? `\n\n（完整清单：${options.storeFile}；pitfall_list 查看经验，pitfall_summary 看日/周总结。）`
    : ''

  let text = ''
  let sections = 0
  for (const block of blocks) {
    const candidate = text === '' ? block : `${text}\n\n${block}`
    if (Buffer.byteLength(candidate + footer, 'utf8') > maxBytes) break
    text = candidate
    sections += 1
  }
  if (text === '') return { text: '', sections: 0 }
  return { text: text + footer, sections }
}

/** 同一会话内重复踩坑的一句话提醒。 */
export function renderRepeatWarn(lesson, times) {
  const meta = metaOf(lesson.category)
  return (
    `⚠️ 又踩到同一个坑（本会话第 ${times} 次）：${meta.icon} ${lesson.title}。` +
    `正确做法：${clip(lesson.advice || '换个做法，别原样重试。', 240)}`
  )
}

/** 人可读的 lessons.md。 */
export function renderLessonsMarkdown(lessons, { updatedAt = '', dir = '' } = {}) {
  const active = lessons.filter((lesson) => lesson.status === 'active')
  const resolved = lessons.filter((lesson) => lesson.status === 'resolved')
  const muted = lessons.filter((lesson) => lesson.status === 'muted')

  const lines = []
  lines.push('# 踩坑经验库')
  lines.push('')
  lines.push('> 由 `dsh-pitfall-memory` 自动维护：每次会话结束后把工具失败归并到这里，')
  lines.push('> 下次会话开始时自动把活跃经验注入上下文。')
  lines.push('')
  if (updatedAt) lines.push(`最后更新：${updatedAt}`)
  if (dir) lines.push(`存储目录：\`${dir}\``)
  lines.push('')
  const ruleCards = buildRuleCards(active, { max: 10 })
  if (ruleCards.length > 0) {
    lines.push('## 规则卡（从经验里压出的可执行清单）')
    lines.push('')
    ruleCards.forEach((card, index) => {
      lines.push(`${index + 1}. ${card.icon} **${card.rootLabel}**：${card.line}`)
    })
    lines.push('')
  }
  lines.push(`## 活跃经验（${active.length}）`)
  lines.push('')
  if (active.length === 0) {
    lines.push('暂无。继续正常工作即可，踩到坑会自动记录。')
    lines.push('')
  }
  active.forEach((lesson, index) => {
    const meta = metaOf(lesson.category)
    lines.push(`### ${index + 1}. ${meta.icon} ${lesson.title}${countSuffix(lesson)}`)
    lines.push('')
    lines.push(`- 类别：${meta.label}（\`${lesson.category}\`）`)
    lines.push(`- 根因族：${(ROOT_CAUSES[rootCauseOf(lesson)] ?? ROOT_CAUSES.unknown).label}`)
    lines.push(`- 首次：${lesson.firstSeen}　最近：${lesson.lastSeen}`)
    lines.push(`- 涉及项目：${lesson.projects.length > 0 ? lesson.projects.join('、') : '（未记录）'}`)
    if (lesson.examples?.[0]?.command) lines.push(`- 最近触发：\`${clip(lesson.examples[0].command, 160)}\``)
    lines.push('')
    lines.push('**症状**')
    lines.push('')
    lines.push('```text')
    lines.push(clip(lesson.symptom || '（无记录）', 600))
    lines.push('```')
    lines.push('')
    lines.push('**正确做法**')
    lines.push('')
    lines.push(lesson.advice || '（未总结）')
    lines.push('')
  })

  if (resolved.length + muted.length > 0) {
    lines.push('## 已解决 / 已忽略')
    lines.push('')
    for (const lesson of [...resolved, ...muted]) {
      const meta = metaOf(lesson.category)
      lines.push(
        `- ${lesson.status === 'resolved' ? '✅' : '🙈'} ${meta.icon} ${lesson.title}（${lesson.id}）`,
      )
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

/** 单条经验的可读详情（工具输出用）。 */
export function renderLessonDetail(lesson) {
  const meta = metaOf(lesson.category)
  const lines = [
    `${meta.icon} ${lesson.title}`,
    `id: ${lesson.id}`,
    `签名: ${lesson.signature}`,
    `状态: ${lesson.status}　来源: ${lesson.source}`,
    `出现: ${lesson.occurrences} 次　首次: ${lesson.firstSeen}　最近: ${lesson.lastSeen}`,
    `项目: ${lesson.projects.join('、') || '（未记录）'}`,
    '',
    '症状:',
    lesson.symptom || '（无记录）',
    '',
    '正确做法:',
    lesson.advice || '（未总结）',
  ]
  if (lesson.examples?.length > 0) {
    lines.push('', '样例:')
    for (const example of lesson.examples.slice(0, 2)) {
      lines.push(`- [${example.at}] ${example.tool}: ${example.command || '（无命令）'}`)
      lines.push(`  ${clip(example.symptom, 200)}`)
    }
  }
  return lines.join('\n')
}

/** UTF-8 字节是否放得下。 */
function fits(text, maxBytes) {
  return Buffer.byteLength(text, 'utf8') <= maxBytes
}

/** 按 UTF-8 字节安全截断（不会切断多字节字符）。 */
function truncateToBytes(text, maxBytes) {
  if (maxBytes <= 0) return ''
  if (fits(text, maxBytes)) return text
  let output = ''
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    output += char
    used += size
  }
  return output
}