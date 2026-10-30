/**
 * 设置页后端测试：API 投影、路由分发与安全边界。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { SummaryBook } from '../lib/rollups.js'
import { API_PREFIX, createApi, mountApi } from '../lib/settings-api.js'
import { PitfallStore } from '../lib/store.js'

const BASE = path.join(os.tmpdir(), 'dsh-pitfall-memory-tests', path.basename(import.meta.dirname, '.mjs'))

function tempDir(name) {
  const dir = path.join(BASE, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function seedStore(dir) {
  const store = new PitfallStore({ dir, config: resolveConfig({}) })
  store.remember({
    title: '写入被沙箱拒绝',
    symptom: 'Permission denied: C:\\Users\\QQ\\.dsh\\x',
    advice: '只写工作区 E:\\dsh 或 /tmp',
    category: 'sandbox',
    scope: 'global',
    project: 'e:/dsh',
  })
  store.save()
  const book = new SummaryBook({ dir, store, config: resolveConfig({}) })
  return { store, book }
}

/** 最小 webServer 替身：记录路由，并能按路径调用。 */
function fakeWebServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    async call(pathname, { method = 'GET', headers = {}, body } = {}) {
      const route = routes.get(pathname)
      if (!route) return { status: 404, body: { error: 'not found' } }
      return new Promise((resolve) => {
        const handlers = { data: [], end: [], error: [] }
        const request = {
          method,
          url: pathname,
          headers,
          on(event, handler) {
            if (handlers[event]) handlers[event].push(handler)
          },
          destroy() {},
        }
        const response = {
          statusCode: 200,
          payload: undefined,
          writeHead(status) {
            this.statusCode = status
          },
          end(text) {
            this.payload = text ? JSON.parse(text) : undefined
            resolve({ status: this.statusCode, body: this.payload })
          },
        }
        route.handler(request, response)
        // 注册完监听器后再按真实顺序推数据。
        queueMicrotask(() => {
          if (body !== undefined) {
            const chunk = Buffer.from(JSON.stringify(body))
            for (const handler of handlers.data) handler(chunk)
          }
          for (const handler of handlers.end) handler()
        })
      })
    },
  }
}

test('API 概览与列表投影', () => {
  const dir = tempDir('api-overview')
  const { store, book } = seedStore(dir)
  const api = createApi({ store, book, config: resolveConfig({}) })

  const overview = api.overview()
  assert.equal(overview.total, 1)
  assert.equal(overview.byStatus.active, 1)
  assert.ok(overview.storeFile.endsWith('lessons.json'))
  assert.ok(Array.isArray(overview.ruleCards))

  const list = api.list({ status: 'active' })
  assert.equal(list.total, 1)
  assert.equal(list.lessons[0].title, '写入被沙箱拒绝')
  assert.match(list.lessons[0].advice, /工作区/)

  assert.equal(api.list({ status: 'resolved' }).total, 0)
  store.close()
})

test('改状态与重生成总结', () => {
  const dir = tempDir('api-actions')
  const { store, book } = seedStore(dir)
  const api = createApi({ store, book, config: resolveConfig({}) })
  const id = store.lessons[0].id

  assert.deepEqual(api.setStatus({ id, status: 'bad' }).ok, false)
  assert.deepEqual(api.setStatus({ id: 'nope', status: 'resolved' }).ok, false)
  const updated = api.setStatus({ id, status: 'resolved' })
  assert.equal(updated.ok, true)
  assert.equal(store.lessons[0].status, 'resolved')

  const refreshed = api.refresh()
  assert.equal(refreshed.ok, true)
  store.close()
})

test('路由：GET/POST 正常路径', async () => {
  const dir = tempDir('api-routes')
  const { store, book } = seedStore(dir)
  const api = createApi({ store, book, config: resolveConfig({}) })
  const webServer = fakeWebServer()
  const disposers = mountApi({ webServer, api })

  const overview = await webServer.call(`${API_PREFIX}/overview`)
  assert.equal(overview.status, 200)
  assert.equal(overview.body.ok, true)
  assert.equal(overview.body.value.total, 1)

  const list = await webServer.call(`${API_PREFIX}/list`)
  assert.equal(list.status, 200)
  assert.equal(list.body.value.total, 1)

  const summaries = await webServer.call(`${API_PREFIX}/summaries`)
  assert.equal(summaries.status, 200)
  assert.equal(summaries.body.ok, true)

  const id = store.lessons[0].id
  const setStatus = await webServer.call(`${API_PREFIX}/set-status`, {
    method: 'POST',
    body: { id, status: 'muted' },
  })
  assert.equal(setStatus.status, 200)
  assert.equal(setStatus.body.status, 'muted')

  const refresh = await webServer.call(`${API_PREFIX}/refresh`, { method: 'POST', body: {} })
  assert.equal(refresh.status, 200)

  for (const dispose of disposers) dispose()
  assert.equal(webServer.routes.size, 0, '卸载后路由应清空')
  store.close()
})

test('路由：方法与 Origin 校验', async () => {
  const dir = tempDir('api-guard')
  const { store, book } = seedStore(dir)
  const api = createApi({ store, book, config: resolveConfig({}) })
  const webServer = fakeWebServer()
  mountApi({ webServer, api })

  const wrongMethod = await webServer.call(`${API_PREFIX}/overview`, { method: 'POST' })
  assert.equal(wrongMethod.status, 405)

  const badOrigin = await webServer.call(`${API_PREFIX}/overview`, {
    headers: { origin: 'https://evil.example', host: '127.0.0.1:1234' },
  })
  assert.equal(badOrigin.status, 403)

  const goodOrigin = await webServer.call(`${API_PREFIX}/overview`, {
    headers: { origin: 'http://127.0.0.1:1234', host: '127.0.0.1:1234' },
  })
  assert.equal(goodOrigin.status, 200)

  store.close()
})