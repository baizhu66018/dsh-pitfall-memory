/**
 * 设置页的 HTTP 后端：把经验库暴露成只读 JSON API（外加重生成总结、改状态两个操作）。
 *
 * 为什么不走 Typert Remote：`@Remote()` 是标准 method decorator，而本机 Node 24
 * 直接执行 ESM 时不支持装饰器语法（官方包是编译后的产物）。用 webServer 注册普通
 * 路由完全够用，也不引入构建步骤。
 *
 * 安全：与 dsh-market 同一条纪律——带 Origin 头时必须匹配环回 Host，
 * 否则拒绝；无 Origin（Node fetch / 本机代理）视为可信。
 *
 * @module dsh-pitfall-memory/settings-api
 */
import { renderDailyDigest, renderWeeklyDigest } from './summary.js'
import { clip } from './util.js'

export const API_PREFIX = '/dsh-pitfall-memory/api'

/** 把 store/book 的能力包成设置页用的只读投影。 */
export function createApi({ store, book, config }) {
  function overview() {
    const lessons = store.lessons ?? []
    const active = lessons.filter((lesson) => lesson.status === 'active')
    const byCategory = {}
    for (const lesson of lessons) byCategory[lesson.category] = (byCategory[lesson.category] ?? 0) + 1
    return {
      version: config.version ?? '',
      storeFile: store.file,
      dir: store.dir,
      total: lessons.length,
      byStatus: {
        active: active.length,
        resolved: lessons.filter((lesson) => lesson.status === 'resolved').length,
        muted: lessons.filter((lesson) => lesson.status === 'muted').length,
      },
      byCategory,
      ruleCards: store.ruleCardsForUi?.() ?? [],
      heartbeat: (store.heartbeat?.() ?? []).slice(-20),
    }
  }

  function list(options = {}) {
    const status = typeof options.status === 'string' ? options.status : 'all'
    const category = typeof options.category === 'string' ? options.category : ''
    const rows = (store.lessons ?? [])
      .filter((lesson) => (status === 'all' ? true : lesson.status === status))
      .filter((lesson) => (category === '' ? true : lesson.category === category))
      .sort((a, b) => {
        if (b.severity !== a.severity) return b.severity - a.severity
        if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences
        return a.lastSeen < b.lastSeen ? 1 : -1
      })
      .slice(0, 300)
    return {
      total: rows.length,
      lessons: rows.map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        category: lesson.category,
        status: lesson.status,
        severity: lesson.severity,
        occurrences: lesson.occurrences,
        source: lesson.source,
        firstSeen: lesson.firstSeen,
        lastSeen: lesson.lastSeen,
        projects: lesson.projects,
        symptom: clip(lesson.symptom ?? '', 500),
        advice: clip(lesson.advice ?? '', 500),
        example: lesson.examples?.[0]?.command ?? '',
      })),
    }
  }

  function summaries() {
    const sessionFiles = book?.listSummaryFiles?.('session') ?? []
    const daily = book?.latestDaily?.()
    const weekly = book?.latestWeekly?.()
    return {
      session: sessionFiles.slice(0, 20),
      daily,
      weekly,
      dailyText: daily ? renderDailyDigest(daily) : '',
      weeklyText: weekly ? renderWeeklyDigest(weekly) : '',
    }
  }

  function setStatus(input = {}) {
    const id = String(input.id ?? '').trim()
    const status = String(input.status ?? '').trim()
    if (id === '') return { ok: false, error: 'id 不能为空' }
    if (!['active', 'resolved', 'muted'].includes(status)) return { ok: false, error: 'status 不合法' }
    const lesson = store.setStatus(id, status)
    if (!lesson) return { ok: false, error: `找不到经验：${id}` }
    store.save()
    return { ok: true, id: lesson.id, status: lesson.status }
  }

  function refresh() {
    if (!book) return { ok: false, error: '总结模块未初始化' }
    const result = book.refreshNow?.() ?? {}
    return { ok: true, ...result }
  }

  return { overview, list, summaries, setStatus, refresh }
}

/**
 * 注册路由。
 * @param {object} options
 * @param {object} options.webServer webServer 服务
 * @param {object} options.api createApi 的返回值
 * @param {() => void} [options.onRefresh]
 * @returns {Array<() => void>} disposers
 */
export function mountApi({ webServer, api }) {
  const sendJson = (response, status, payload) => {
    response.writeHead(status, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    })
    response.end(JSON.stringify(payload))
  }

  const trusted = (request) => {
    const origin = request.headers.origin
    if (origin === undefined) return true
    try {
      return new URL(origin).host === request.headers.host
    } catch {
      return false
    }
  }

  const readBody = (request) =>
    new Promise((resolve) => {
      let raw = ''
      request.on('data', (chunk) => {
        raw += chunk
        if (raw.length > 64 * 1024) request.destroy()
      })
      request.on('end', () => {
        try {
          resolve(raw === '' ? {} : JSON.parse(raw))
        } catch {
          resolve({})
        }
      })
      request.on('error', () => resolve({}))
    })

  const routes = [
    {
      kind: 'exact',
      path: `${API_PREFIX}/overview`,
      handler: (request, response) => {
        if (request.method !== 'GET') return sendJson(response, 405, { error: 'method not allowed' })
        if (!trusted(request)) return sendJson(response, 403, { error: 'untrusted origin' })
        try {
          sendJson(response, 200, { ok: true, value: api.overview() })
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/list`,
      handler: (request, response) => {
        if (request.method !== 'GET') return sendJson(response, 405, { error: 'method not allowed' })
        if (!trusted(request)) return sendJson(response, 403, { error: 'untrusted origin' })
        try {
          const url = new URL(request.url ?? API_PREFIX, 'http://localhost')
          sendJson(response, 200, {
            ok: true,
            value: api.list({
              status: url.searchParams.get('status') ?? 'all',
              category: url.searchParams.get('category') ?? '',
            }),
          })
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/summaries`,
      handler: (request, response) => {
        if (request.method !== 'GET') return sendJson(response, 405, { error: 'method not allowed' })
        if (!trusted(request)) return sendJson(response, 403, { error: 'untrusted origin' })
        try {
          sendJson(response, 200, { ok: true, value: api.summaries() })
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/set-status`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' })
        if (!trusted(request)) return sendJson(response, 403, { error: 'untrusted origin' })
        const body = await readBody(request)
        try {
          const result = api.setStatus(body)
          sendJson(response, result.ok ? 200 : 400, result)
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/refresh`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' })
        if (!trusted(request)) return sendJson(response, 403, { error: 'untrusted origin' })
        try {
          const result = api.refresh()
          sendJson(response, result.ok ? 200 : 400, result)
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
  ]

  return routes.map((route) => webServer.register(route))
}