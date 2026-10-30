/**
 * 通用工具：哈希、文本清洗、JSON 原子读写、路径与项目根解析。
 *
 * 这一层不依赖 DSH 运行时，可在纯 Node 下测试。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 稳定 sha1（签名、消息 id 用）。 */
export function sha1(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex')
}

/** ISO 时间戳。 */
export function nowIso() {
  return new Date().toISOString()
}

/** 按字符截断，超长补省略号。 */
export function clip(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

/** 去掉 ANSI 颜色与回车，统一换行。 */
export function stripAnsi(text) {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
}

/** 只保留非空行，去掉行尾空白。 */
export function meaningfulLines(text) {
  return stripAnsi(text)
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .filter((line) => line.trim() !== '')
}

/** 读取 JSON；不存在或损坏时返回 fallback。 */
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 先写临时文件再 rename，避免半截 JSON。 */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
}

/** 追加一行 NDJSON；失败静默（诊断不应反过来影响主流程）。 */
export function appendNdjson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
  } catch {
    /* ignore */
  }
}

/** DSH_HOME：显式配置 > 环境变量 > ~/.dsh。 */
export function resolveDshHome(override) {
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override.trim())
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') {
    return path.resolve(process.env.DSH_HOME.trim())
  }
  return path.join(os.homedir(), '.dsh')
}

/**
 * profile 目录：优先读 profileContext 服务，其次 DSH_PROFILE_DIR，最后按 desktop 猜。
 */
export function resolveProfileDir(ctx, override) {
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override.trim())
  try {
    const profileContext = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined
    if (
      profileContext &&
      typeof profileContext.dir === 'string' &&
      profileContext.dir.trim() !== ''
    ) {
      return path.resolve(profileContext.dir)
    }
  } catch {
    /* 服务不存在时忽略 */
  }
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR.trim() !== '') {
    return path.resolve(process.env.DSH_PROFILE_DIR.trim())
  }
  if (
    typeof process.env.DSH_PROFILE === 'string' &&
    process.env.DSH_PROFILE.trim() !== ''
  ) {
    return path.join(resolveDshHome(), 'profiles', process.env.DSH_PROFILE.trim())
  }
  return path.join(resolveDshHome(), 'profiles', 'desktop')
}

/** 统一成小写、正斜杠、去尾斜杠的路径键。 */
export function normalizePathKey(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  return path.resolve(value.trim()).replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

/**
 * 项目根：从 cwd 向上找第一个含 `.git` 或 `AGENTS.md` 的目录。
 * 找不到就用 cwd 本身。用于把经验归到「项目」而不是某个子目录。
 */
export function projectKeyOf(cwd) {
  const start = typeof cwd === 'string' && cwd.trim() !== '' ? path.resolve(cwd.trim()) : ''
  if (start === '') return ''
  let current = start
  for (let depth = 0; depth < 16; depth += 1) {
    if (hasProjectMarker(current)) return normalizePathKey(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return normalizePathKey(start)
}

function hasProjectMarker(dir) {
  for (const marker of ['.git', 'AGENTS.md', 'CLAUDE.md']) {
    try {
      fs.statSync(path.join(dir, marker))
      return true
    } catch {
      /* 继续找 */
    }
  }
  return false
}

/** 项目展示名（经验注入里用）。 */
export function projectLabel(projectKey) {
  if (!projectKey) return '（未知项目）'
  const base = projectKey.split('/').filter(Boolean).pop() ?? projectKey
  return base
}

/** 深度冻结的 JSON 快照（防止把可变对象交出去）。 */
export function jsonClone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** 把任意 Error/值转成一行可读文本。 */
export function errorText(error) {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}