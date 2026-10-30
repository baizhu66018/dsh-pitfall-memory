/**
 * 重建可读产物：按当前总结框架重写 lessons.md，并补齐日/周总结。
 *
 * 用途：
 *   - 改了渲染格式或总结框架后，不必等下一次会话；
 *   - 想在重启 DSH 前先看看生成了什么。
 *
 * 用法：
 *   node scripts/rebuild.mjs
 *   node scripts/rebuild.mjs --profile desktop --home "$DSH_HOME"
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from '../lib/config.js'
import { renderLessonsMarkdown } from '../lib/render.js'
import { SummaryBook, localDateKey, localWeekKey } from '../lib/rollups.js'
import { PitfallStore } from '../lib/store.js'
import { buildRuleCards } from '../lib/summary.js'

function argValue(flag) {
  const index = process.argv.indexOf(`--${flag}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

const profile = argValue('profile') ?? 'desktop'
const home = argValue('home') ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const dir = path.join(home, 'profiles', profile, '.dsh-pitfall-memory')

if (!fs.existsSync(dir)) {
  process.stderr.write(`经验库目录不存在：${dir}\n先让插件在新会话里跑一次，或用 doctor 检查安装。\n`)
  process.exit(1)
}

const config = resolveConfig({})
const store = new PitfallStore({ dir, config })
const book = new SummaryBook({ dir, store, config })

const markdown = renderLessonsMarkdown(store.lessons, {
  updatedAt: new Date().toISOString(),
  dir,
})
fs.writeFileSync(path.join(dir, 'lessons.md'), markdown, 'utf8')

const checks = book.ensure(new Date())
const today = localDateKey(new Date())
const currentWeek = localWeekKey(new Date())
// ensure 每天只跑一次；重建时显式刷新当天，保证用的是当前渲染/统计逻辑。
book.refreshDaily(today)
book.refreshWeekly(currentWeek)
store.save()

const active = store.lessons.filter((lesson) => lesson.status === 'active')
const rules = buildRuleCards(active, { max: 10 })
const dailyFile = path.join(dir, 'summaries', `daily-${localDateKey(new Date())}.md`)
const weeklyFile = path.join(dir, 'summaries', `weekly-${currentWeek}.md`)
const lines = []
lines.push(`经验：${store.lessons.length} 条（活跃 ${active.length}）`)
lines.push(`规则卡：${rules.length} 条`)
for (const card of rules.slice(0, 5)) lines.push(`  ${card.icon} ${card.rootLabel}：${card.line}`)
lines.push(`日总结：${dailyFile}${fs.existsSync(dailyFile) ? '' : '（当天暂无失败，未生成）'}`)
lines.push(`周总结：${weeklyFile}${fs.existsSync(weeklyFile) ? '' : '（本周暂无数据，未生成）'}`)
if (checks.length > 0) lines.push(`本次补生成：${checks.map(([kind, key]) => `${kind}:${key}`).join(', ')}`)
lines.push(`lessons.md 已重写：${path.join(dir, 'lessons.md')}`)

process.stdout.write(`${lines.join('\n')}\n`)