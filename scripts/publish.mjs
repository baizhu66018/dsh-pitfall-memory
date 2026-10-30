/**
 * 一键把插件发布到 GitHub 并提交 market 收录 PR。
 *
 * 全程只依赖 GitHub REST API + git，不需要 gh CLI。
 *
 * 用法（token 只从环境变量读，绝不写进文件）：
 *   GITHUB_TOKEN=xxx node scripts/publish.mjs --phase repo
 *   GITHUB_TOKEN=xxx node scripts/publish.mjs --phase entry     # 建仓满 1 天后
 *   GITHUB_TOKEN=xxx node scripts/publish.mjs --status          # 看进度
 *
 * 阶段：
 *   repo   建仓库 + 推代码 + 加 topic
 *   entry  fork 收录仓库 + 加 YAML 条目 + 提 PR
 *   status 只读检查当前进度
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const API = 'https://api.github.com'
const UPSTREAM = { owner: 'awesome-dsh-plugin', repo: 'awesome-dsh-plugin' }

const token = process.env.GITHUB_TOKEN ?? ''
const phase = (() => {
  const index = process.argv.indexOf('--phase')
  return index === -1 ? 'status' : process.argv[index + 1]
})()

function log(message) {
  process.stdout.write(`${message}\n`)
}

async function api(method, endpoint, body) {
  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-pitfall-memory-publish',
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let data
  try {
    data = text === '' ? {} : JSON.parse(text)
  } catch {
    data = { raw: text }
  }
  if (response.status >= 400) {
    const detail = data.message ?? data.raw ?? `HTTP ${response.status}`
    const error = new Error(`${method} ${endpoint} → ${response.status}: ${detail}`)
    error.status = response.status
    error.data = data
    throw error
  }
  return data
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.quiet ? 'pipe' : 'inherit',
    ...options,
  })
}

async function whoami() {
  const user = await api('GET', '/user')
  return user.login
}

function checkToken() {
  if (token === '') {
    log('缺少 GITHUB_TOKEN。用法：')
    log('  GITHUB_TOKEN=<你的 token> node scripts/publish.mjs --phase repo')
    log('')
    log('token 在 https://github.com/settings/tokens 生成，勾选 repo 权限即可。')
    process.exit(1)
  }
}

/** 仓库是否已存在（返回 null 表示还没有）。 */
async function existingRepo(owner, repo) {
  try {
    return await api('GET', `/repos/${owner}/${repo}`)
  } catch (error) {
    if (error.status === 404) return null
    throw error
  }
}

// ── 阶段：建仓库 + 推代码 ────────────────────────────────────────────────

async function phaseRepo() {
  const user = await whoami()
  log(`登录身份：${user}`)

  const repoName = pkg.name
  let repo = await existingRepo(user, repoName)

  if (repo === null) {
    log(`创建仓库 ${user}/${repoName} …`)
    repo = await api('POST', '/user/repos', {
      name: repoName,
      description: pkg.description,
      private: false,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
    })
    log(`✅ 仓库已创建：${repo.html_url}`)
    log(`   创建时间：${repo.created_at}（满 1 天后才能提收录 PR）`)
  } else {
    log(`仓库已存在：${repo.html_url}`)
    log(`   创建时间：${repo.created_at}`)
  }

  // git 初始化与推送
  if (!fs.existsSync(path.join(root, '.git'))) {
    log('初始化本地 git 仓库 …')
    git(['init', '-q'])
    git(['add', '-A'])
    git([
      '-c', 'user.name=dsh-pitfall-memory',
      '-c', 'user.email=dsh-pitfall-memory@users.noreply.github.com',
      'commit', '-q', '-m', 'feat: failure memory for DeepSeek Harness',
    ])
    git(['branch', '-M', 'main'])
    log('✅ 本地提交完成')
  } else {
    log('本地已是 git 仓库，跳过 init')
  }

  const remote = `https://x-access-token:${token}@github.com/${user}/${repoName}.git`
  const remotes = git(['remote'], { quiet: true }).trim().split('\n').filter(Boolean)
  if (remotes.includes('origin')) git(['remote', 'set-url', 'origin', remote])
  else git(['remote', 'add', 'origin', remote])

  log('推送代码 …')
  git(['push', '-u', 'origin', 'main', '--force'], { stdio: 'pipe' })
  log('✅ 代码已推送')

  // 去掉 URL 里的 token，避免留在 .git/config
  git(['remote', 'set-url', 'origin', `https://github.com/${user}/${repoName}.git`])

  // topic（收录要求）
  log('设置 topic: dsh-plugin …')
  try {
    await api('PUT', `/repos/${user}/${repoName}/topics`, {
      names: ['dsh-plugin', 'deepseek-harness', 'memory', 'lessons'],
    })
    log('✅ topic 已设置')
  } catch (error) {
    log(`⚠️ topic 设置失败（可手动在仓库页面加）：${error.message}`)
  }

  const created = new Date(repo.created_at)
  const readyAt = new Date(created.getTime() + 24 * 60 * 60 * 1000)
  log('')
  log(`下一步：等仓库满 1 天（${readyAt.toISOString()} 之后），再运行`)
  log(`  GITHUB_TOKEN=<token> node scripts/publish.mjs --phase entry`)
}

// ── 阶段：提收录 PR ────────────────────────────────────────────────────

function entryYaml(owner, repo) {
  const escape = (text) => {
    const value = String(text).trim()
    return value.includes(': ') ? `"${value.replaceAll('"', '\\"')}"` : value
  }
  return [
    `url: https://github.com/${owner}/${repo}`,
    `name: ${owner}/${repo}`,
    'category: memory',
    'description:',
    `  en: ${escape(
      'Failure memory for DeepSeek Harness. Captures tool failures as they happen, classifies them with 16 built-in rules into lessons pairing a symptom with a fix, adds session/daily/weekly summaries, and injects a short briefing into later sessions through systemPrompt context. Ships 5 pitfall_ tools and a web settings page.',
    )}`,
    `  zh: ${escape(
      '面向 DeepSeek Harness 的失败记忆插件。运行中捕获工具失败，用 16 条内置规则归并成「症状 + 正确做法」的经验，附带会话/天/周三级总结，并通过 systemPrompt context 把简报注入后续会话。提供 5 个 pitfall_ 工具与 Web 设置页。',
    )}`,
    '',
  ].join('\n')
}

async function phaseEntry() {
  const user = await whoami()
  log(`登录身份：${user}`)

  const repo = await existingRepo(user, pkg.name)
  if (repo === null) {
    log(`❌ 还没有仓库 ${user}/${pkg.name}，先跑 --phase repo`)
    process.exit(1)
  }
  const ageMs = Date.now() - new Date(repo.created_at).getTime()
  const ageHours = ageMs / 3600000
  log(`仓库年龄：${ageHours.toFixed(1)} 小时`)
  if (ageHours < 24) {
    const wait = ((24 - ageHours) * 3600 * 1000) / 1000 / 60
    log(`❌ 还没满 1 天，约 ${Math.ceil(wait)} 分钟后再来（CI 会拒）。`)
    process.exit(1)
  }

  // 1. fork（如果还没有）
  const forkName = UPSTREAM.repo
  let fork = await existingRepo(user, forkName)
  if (fork === null) {
    log(`fork ${UPSTREAM.owner}/${UPSTREAM.repo} …`)
    fork = await api('POST', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/forks`, { default_branch_only: true })
    log(`✅ 已 fork：${fork.html_url}`)
    log('   等 fork 初始化（约 10 秒）…')
    await new Promise((resolve) => setTimeout(resolve, 10000))
  } else {
    log(`已有 fork：${fork.html_url}`)
  }

  // 2. 取 upstream 默认分支
  const upstream = await api('GET', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}`)
  const base = upstream.default_branch

  // 3. 建分支
  const branch = `add-${pkg.name}`
  const refBase = await api('GET', `/repos/${user}/${forkName}/git/ref/heads/${base}`)
  const baseSha = refBase.object.sha
  let branchExists = true
  try {
    await api('GET', `/repos/${user}/${forkName}/git/ref/heads/${branch}`)
  } catch (error) {
    if (error.status !== 404) throw error
    branchExists = false
  }
  if (!branchExists) {
    log(`创建分支 ${branch} …`)
    await api('POST', `/repos/${user}/${forkName}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    })
    log('✅ 分支已创建')
  } else {
    log(`分支 ${branch} 已存在`)
  }

  // 4. 写条目文件
  const filePath = `data/plugins/${user}__${pkg.name}.yml`
  const content = Buffer.from(entryYaml(user, pkg.name), 'utf8').toString('base64')
  let existingSha
  try {
    const existing = await api('GET', `/repos/${user}/${forkName}/contents/${filePath}?ref=${branch}`)
    existingSha = existing.sha
    log(`条目文件已存在，将更新`)
  } catch (error) {
    if (error.status !== 404) throw error
  }
  await api('PUT', `/repos/${user}/${forkName}/contents/${filePath}`, {
    message: `Add ${pkg.name}`,
    content,
    branch,
    ...(existingSha === undefined ? {} : { sha: existingSha }),
  })
  log(`✅ 已写入 ${filePath}`)

  // 5. 提 PR
  let prs = []
  try {
    prs = await api('GET', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls?head=${user}:${branch}&state=all`)
  } catch {
    prs = []
  }
  if (Array.isArray(prs) && prs.length > 0) {
    log(`PR 已存在：#${prs[0].number} ${prs[0].html_url}（状态 ${prs[0].state}）`)
    return
  }

  log('创建 PR …')
  const pr = await api('POST', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls`, {
    title: `Add ${pkg.name}`,
    head: `${user}:${branch}`,
    base,
    body: [
      `Adds **${pkg.name}**, a failure-memory plugin for DeepSeek Harness.`,
      '',
      '- Captures tool failures via `session/event`; 16 built-in rules turn them into lessons pairing a symptom with a fix.',
      '- Session / daily / weekly summaries (four-layer convergence: observation → lesson → pattern → rule).',
      '- Injects a short briefing through `systemPrompt.context`, so it applies to later sessions and restored ones.',
      '- 5 `pitfall_*` tools and a Web settings page (Settings → Plugins).',
      '',
      `Declares both \`dsh.bundle\` and \`dsh.client\`; 50 tests run with plain Node.`,
      '',
      `Repo: https://github.com/${user}/${pkg.name}`,
    ].join('\n'),
  })
  log(`✅ PR 已创建：#${pr.number}`)
  log(`   ${pr.html_url}`)
}

// ── 阶段：状态 ────────────────────────────────────────────────────────

async function phaseStatus() {
  checkToken()
  const user = await whoami()
  log(`登录身份：${user}`)

  const repo = await existingRepo(user, pkg.name)
  if (repo === null) {
    log(`❌ 仓库 ${user}/${pkg.name} 还不存在 → 需要 --phase repo`)
    return
  }
  const ageHours = (Date.now() - new Date(repo.created_at).getTime()) / 3600000
  log(`✅ 仓库：${repo.html_url}`)
  log(`   年龄 ${ageHours.toFixed(1)} 小时 ${ageHours >= 24 ? '（已满 1 天，可以提 PR）' : '（还没满 1 天）'}`)
  log(`   topics: ${(repo.topics ?? []).join(', ') || '（无）'}`)

  const fork = await existingRepo(user, UPSTREAM.repo)
  log(fork === null ? '⏳ 收录仓库尚未 fork' : `✅ 已 fork：${fork.html_url}`)

  try {
    const filePath = `data/plugins/${user}__${pkg.name}.yml`
    await api('GET', `/repos/${user}/${UPSTREAM.repo}/contents/${filePath}`)
    log(`✅ 条目文件已提交：${filePath}`)
  } catch (error) {
    if (error.status === 404) log('⏳ 条目文件还没提交')
    else log(`⚠️ 检查条目失败：${error.message}`)
  }

  try {
    const prs = await api('GET', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls?head=${user}:add-${pkg.name}&state=all`)
    if (Array.isArray(prs) && prs.length > 0) {
      log(`✅ PR #${prs[0].number}（${prs[0].state}${prs[0].merged_at ? '，已合并' : ''}）：${prs[0].html_url}`)
    } else {
      log('⏳ 还没有 PR')
    }
  } catch {
    log('⚠️ 查询 PR 失败')
  }
}

checkToken()
if (phase === 'repo') await phaseRepo()
else if (phase === 'entry') await phaseEntry()
else await phaseStatus()
