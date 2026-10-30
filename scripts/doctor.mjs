/**
 * 自检：确认插件装好了、经验库在哪、有没有加载痕迹。
 *
 * 用法：
 *   node scripts/doctor.mjs
 *   node scripts/doctor.mjs --profile desktop --home "$DSH_HOME"
 *
 * 只读，不修改任何文件。
 */
import fs from 'node:fs'
import os from 'node:os'
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

const profile = argValue('profile') ?? 'desktop'
const home = argValue('home') ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const profileDir = path.join(home, 'profiles', profile)
const manifestPath = path.join(profileDir, 'package.json')
const dest = path.join(profileDir, 'node_modules', pkg.name)
const storeDir = process.env.DSH_PITFALL_STORE ?? path.join(profileDir, '.dsh-pitfall-memory')

const lines = []
const ok = (text) => lines.push(`✅ ${text}`)
const warn = (text) => lines.push(`⚠️  ${text}`)
const bad = (text) => lines.push(`❌ ${text}`)
const debug = (text) => lines.push(`ℹ️  ${text}`)

lines.push(`插件：${pkg.name}@${pkg.version}`)
lines.push(`源码：${root}`)
lines.push(`profile：${profileDir}`)
lines.push('')

// 1. bundle 是否挂载
if (!fs.existsSync(manifestPath)) {
  bad(`找不到 profile 清单：${manifestPath}`)
} else {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles ?? []
    if (bundles.includes(pkg.name)) ok(`已挂载到 dsh.profile.bundles（共 ${bundles.length} 项）`)
    else bad(`未挂载：${pkg.name} 不在 dsh.profile.bundles 里，运行 scripts/install.mjs`)
  } catch (error) {
    bad(`profile 清单不是合法 JSON：${error.message}`)
  }
}

// 2. 文件是否复制到位
if (fs.existsSync(path.join(dest, 'lib', 'index.js'))) ok(`文件已复制：${dest}`)
else bad(`文件缺失：${dest}（运行 scripts/install.mjs）`)

// 3. 经验库
const lessonsFile = path.join(storeDir, 'lessons.json')
if (fs.existsSync(lessonsFile)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lessonsFile, 'utf8'))
    const lessons = Array.isArray(parsed.lessons) ? parsed.lessons : []
    const active = lessons.filter((lesson) => lesson.status === 'active').length
    ok(`经验库：${lessons.length} 条（活跃 ${active}），更新于 ${parsed.updatedAt ?? '未知'}`)
    for (const lesson of lessons.slice(0, 5)) {
      lines.push(`   · [${lesson.category}] ${lesson.title}（×${lesson.occurrences ?? 1}）`)
    }
    if (lessons.length > 5) lines.push(`   · ……其余 ${lessons.length - 5} 条见 lessons.md`)
  } catch (error) {
    bad(`经验库损坏：${lessonsFile}（${error.message}）`)
  }
} else {
  warn(`经验库尚未生成：${lessonsFile}`)
  lines.push('   （插件在第一次会话/第一次失败后创建；如果重启过仍没有，检查下面的日志。）')
  lines.push(`   lessons.md：${path.join(storeDir, 'lessons.md')}`)
}

// 4. 加载与注入痕迹：优先看插件自己的心跳，它比启动日志更准
const heartbeatFile = path.join(storeDir, '.heartbeat.jsonl')
if (fs.existsSync(heartbeatFile)) {
  const rows = fs
    .readFileSync(heartbeatFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined
      }
    })
    .filter(Boolean)
  const counts = {}
  for (const row of rows) counts[row.event] = (counts[row.event] ?? 0) + 1
  const last = rows[rows.length - 1]
  if (counts['apply-ok'] > 0) {
    ok(`心跳：apply-ok ${counts['apply-ok']} 次（最近 ${last?.at ?? '?'}，pid ${last?.pid ?? '?'}，v${last?.version ?? '?'}）`)
    const renders = counts['context-render'] ?? 0
    if (renders > 0) ok(`心跳：简报已渲染 ${renders} 次（注入通道正常）`)
    else warn('心跳：还没有 context-render —— 说明还没发过消息，或注入通道没被读取。')
    if (counts.captured) ok(`心跳：捕获 ${counts.captured} 次`)
    if (counts['settings-api-mounted']) {
      ok(`心跳：设置页接口已挂载（${counts['settings-api-mounted']} 次）`)
    } else {
      warn('心跳：设置页接口未挂载（没有 webServer，或在 headless/tui profile 下运行）。')
    }
  } else {
    bad('心跳里没有 apply-ok —— 插件没有成功加载，检查 profile 的 bundles 与文件复制。')
  }
} else {
  warn(`心跳文件不存在：${heartbeatFile}`)
  lines.push('   （插件加载时会创建；如果重启过仍没有，说明它根本没被加载。）')
}

// 4.5 设置页：host 侧 API 是否挂载 + client 声明是否就绪
try {
  const profilePkg = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'))
  const decl = profilePkg.dsh?.client
  const clientRel = profilePkg.exports?.['./client']
  if (decl?.platform === 'web' && typeof clientRel === 'string') {
    const clientAbs = path.join(dest, clientRel.replace(/^\.\//, ''))
    if (fs.existsSync(clientAbs)) {
      ok(`设置页：client 声明就绪（${clientRel}，${fs.statSync(clientAbs).size} 字节）`)
      lines.push('   ⚠️ 这一页只在 DSH 启动时扫描；热重载不会重新扫描，改完需要重启才会出现在设置里。')
    } else {
      bad(`设置页：声明了 ${clientRel} 但文件不存在`)
    }
  } else {
    warn('设置页：package.json 缺少 dsh.client 或 exports["./client"]')
  }
} catch (error) {
  bad(`设置页：读取 profile 内 package.json 失败（${error.message}）`)
}

// 5. 启动日志里有没有加载痕迹
const logsDir = path.join(home, 'logs')
if (fs.existsSync(logsDir)) {
  const startups = fs
    .readdirSync(logsDir)
    .filter((name) => name.startsWith('startup-') && name.endsWith('.log'))
    .sort()
    .reverse()
    .slice(0, 3)
  let found = false
  for (const name of startups) {
    try {
      const text = fs.readFileSync(path.join(logsDir, name), 'utf8')
      const hits = text
        .split('\n')
        .filter((line) => /pitfall|踩坑/i.test(line))
        .slice(-5)
      if (hits.length > 0) {
        found = true
        lines.push(`日志（${name}）：`)
        for (const hit of hits) lines.push(`   ${hit.trim()}`)
      }
    } catch {
      /* ignore */
    }
  }
  if (!found) debug('最近 3 个启动日志里没有插件日志行（心跳已可用，可忽略）。')
} else {
  warn(`找不到日志目录：${logsDir}`)
}

lines.push('')
lines.push('提示：插件在进程启动时由 bundle 加载，安装/更新后需要重启 DSH 才生效。')

process.stdout.write(`${lines.join('\n')}\n`)