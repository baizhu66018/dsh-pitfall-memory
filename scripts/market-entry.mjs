/**
 * 生成提交给 awesome-dsh-plugin 的条目文件。
 *
 * 用法：
 *   node scripts/market-entry.mjs --owner <你的 GitHub 用户名>
 *   node scripts/market-entry.mjs --owner octocat --repo dsh-pitfall-memory --out ../awesome-dsh-plugin
 *
 * 只写一个文件：`data/plugins/<owner>__<repo>.yml`（命名与官方 contributing.md 一致）。
 * 不传 --out 时把内容打印到终端，方便直接复制粘贴到 GitHub 网页编辑器。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

function argValue(flag) {
  const index = process.argv.indexOf(`--${flag}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

const owner = argValue('owner')
const repo = argValue('repo') ?? pkg.name
const out = argValue('out')
const category = argValue('category') ?? 'memory'
const icon = argValue('icon')

if (!owner) {
  process.stderr.write(
    '缺少 --owner。用法：\n'
      + '  node scripts/market-entry.mjs --owner <你的 GitHub 用户名>\n'
      + '  node scripts/market-entry.mjs --owner <用户名> --out <awesome-dsh-plugin 仓库路径>\n',
  )
  process.exit(1)
}

// YAML 标量里出现 `: ` 或 `#` 时必须加引号，否则会被解析成嵌套键。
function yamlScalar(text) {
  const value = String(text).trim()
  const needsQuote = value.includes(': ') || value.includes(' #') || /^[-?:,[\]{}#&*!|>'"%@`]/.test(value)
  if (!needsQuote) return value
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

const url = `https://github.com/${owner}/${repo}`

const lines = [
  `url: ${url}`,
  `name: ${owner}/${repo}`,
  `category: ${category}`,
]
if (icon) lines.push(`icon: ${icon}`)
lines.push(
  'description:',
  `  en: ${yamlScalar(
    `Failure memory for DeepSeek Harness. Captures tool failures as they happen, classifies them with ${16} built-in rules into lessons with a symptom and a fix, adds session/daily/weekly summaries, and injects a short briefing into later sessions through systemPrompt context. Ships ${5} pitfall_ tools and a web settings page.`,
  )}`,
  `  zh: ${yamlScalar(
    '面向 DeepSeek Harness 的失败记忆插件。运行中捕获工具失败，用 16 条内置规则归并成「症状 + 正确做法」的经验，附带会话/天/周三级总结，并通过 systemPrompt context 把简报注入后续会话。提供 5 个 pitfall_ 工具与 Web 设置页。',
  )}`,
)
const content = `${lines.join('\n')}\n`

if (out === undefined) {
  process.stdout.write(content)
  process.stdout.write(
    `\n# 文件名应为：${owner}__${repo}.yml\n`
      + '# 放到 awesome-dsh-plugin 仓库的 data/plugins/ 下（一个文件就是全部投稿）。\n',
  )
  process.exit(0)
}

const dir = path.resolve(out, 'data', 'plugins')
if (!fs.existsSync(dir)) {
  process.stderr.write(`目标目录不存在：${dir}\n先把 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin fork 并克隆到本地。\n`)
  process.exit(1)
}
const file = path.join(dir, `${owner}__${repo}.yml`)
if (fs.existsSync(file)) {
  process.stderr.write(`已存在：${file}\n（重复提交同一插件会被拒绝；如需修改请直接编辑该文件。）\n`)
  process.exit(1)
}
fs.writeFileSync(file, content, 'utf8')
process.stdout.write(`已写入：${file}\n`)
process.stdout.write(`下一步：在 awesome-dsh-plugin 仓库里 commit 并提 PR。\n`)
