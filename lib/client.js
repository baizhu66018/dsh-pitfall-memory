/**
 * 浏览器半身：在「设置 → 插件」里加一个「踩坑记忆」设置页。
 *
 * 数据走 host 半身注册的普通 HTTP 接口（/dsh-pitfall-memory/api/*），
 * 不走 Typert Remote —— 装饰器语法在本机 Node 下不可用，且 HTTP 更简单。
 *
 * 这个文件是手写的 `window.__ModuleLoader__` bundle，格式与官方 client 包一致：
 * 由 dsh-client-modules 扫描 package.json 的 `dsh.client` + `exports["./client"]`
 * 后，通过 /plugins/<包名>/bundle.js 提供。
 */
window.__ModuleLoader__.load({
  id: 'dsh-pitfall-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const jsx = require('react/jsx-runtime')

    const API = '/dsh-pitfall-memory/api'

    async function getJson(path) {
      const response = await fetch(path, { headers: { accept: 'application/json' } })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) {
        throw new Error(body.error ?? `HTTP ${response.status}`)
      }
      return body.value
    }

    async function postJson(path, payload) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${response.status}`)
      return body
    }

    // ── 样式（内联，避免额外 CSS 构建） ────────────────────────────────
    const CSS = `
.pm-root{display:flex;flex-direction:column;gap:16px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary)}
.pm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.pm-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-module-platform)}
.pm-card b{display:block;font-size:22px;font-weight:600;line-height:1.2}
.pm-card span{color:var(--dsw-alias-label-tertiary);font-size:12px}
.pm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pm-tabs{display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:8px}
.pm-tab{font:inherit;cursor:pointer;background:0 0;border:1px solid transparent;border-radius:8px;padding:4px 12px;color:var(--dsw-alias-label-secondary)}
.pm-tab[data-active=true]{background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.pm-item{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:6px}
.pm-title{display:flex;align-items:center;gap:8px;font-weight:600}
.pm-badge{font-size:11px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.pm-symptom{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:8px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}
.pm-advice{color:var(--dsw-alias-label-primary)}
.pm-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
.pm-btn{font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 12px;font-size:12px}
.pm-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.pm-btn:disabled{cursor:default;opacity:.6}
.pm-pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:12px;max-height:420px;overflow:auto}
.pm-empty{color:var(--dsw-alias-label-tertiary);padding:24px 0;text-align:center}
.pm-error{color:var(--dsw-alias-label-error)}
`

    const CSS_ID = 'dsh-pitfall-memory/settings.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-pm-css]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.pmCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const CATEGORY_LABEL = {
      sandbox: '🔒 沙箱与权限',
      runtime: '⚙️ 运行时与命令',
      encoding: '🈶 编码与中文',
      network: '🌐 网络与凭据',
      git: '🌿 Git',
      tooling: '🧰 工具与工作流',
      command: '❗ 命令失败',
    }

    const STATUS_LABEL = { active: '活跃', resolved: '已解决', muted: '已忽略' }

    function Card({ value, label }) {
      return jsx.jsx('div', {
        className: 'pm-card',
        children: [jsx.jsx('b', { children: String(value) }), jsx.jsx('span', { children: label })],
      })
    }

    function LessonItem({ lesson, onStatus, busy }) {
      const label = CATEGORY_LABEL[lesson.category] ?? lesson.category
      const [open, setOpen] = react.useState(false)
      return jsx.jsxs('div', {
        className: 'pm-item',
        children: [
          jsx.jsxs('div', {
            className: 'pm-title',
            children: [
              jsx.jsx('span', { children: lesson.title }),
              jsx.jsx('span', { className: 'pm-badge', children: label }),
              jsx.jsx('span', { className: 'pm-badge', children: STATUS_LABEL[lesson.status] ?? lesson.status }),
              lesson.occurrences > 1
                ? jsx.jsx('span', { className: 'pm-badge', children: `×${lesson.occurrences}` })
                : null,
            ],
          }),
          jsx.jsx('div', { className: 'pm-muted', children: `最近：${lesson.lastSeen}　来源：${lesson.source}` }),
          jsx.jsxs('button', {
            type: 'button',
            className: 'pm-btn',
            onClick: () => setOpen((value) => !value),
            children: [open ? '收起' : '展开症状与做法'],
          }),
          open
            ? jsx.jsxs(react.Fragment, {
                children: [
                  jsx.jsx('div', { className: 'pm-symptom', children: lesson.symptom || '（无记录）' }),
                  jsx.jsx('div', { className: 'pm-advice', children: lesson.advice || '（未总结）' }),
                ],
              })
            : null,
          jsx.jsxs('div', {
            className: 'pm-row',
            children: [
              jsx.jsx('button', {
                type: 'button',
                className: 'pm-btn',
                disabled: busy || lesson.status === 'active',
                onClick: () => onStatus(lesson.id, 'active'),
                children: '重新激活',
              }),
              jsx.jsx('button', {
                type: 'button',
                className: 'pm-btn',
                disabled: busy || lesson.status === 'resolved',
                onClick: () => onStatus(lesson.id, 'resolved'),
                children: '标记已解决',
              }),
              jsx.jsx('button', {
                type: 'button',
                className: 'pm-btn',
                disabled: busy || lesson.status === 'muted',
                onClick: () => onStatus(lesson.id, 'muted'),
                children: '忽略',
              }),
            ],
          }),
        ],
      })
    }

    function PitfallSettingsSection() {
      const [tab, setTab] = react.useState('lessons')
      const [status, setStatus] = react.useState('active')
      const [state, setState] = react.useState({ status: 'loading' })
      const [summary, setSummary] = react.useState({ status: 'loading' })
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')
      const [request, setRequest] = react.useState(0)

      react.useEffect(() => {
        let live = true
        setState({ status: 'loading' })
        Promise.all([getJson(`${API}/overview`), getJson(`${API}/list?status=${status}`)])
          .then(
            ([overview, list]) => {
              if (live) setState({ status: 'ready', overview, list })
            },
            (failure) => {
              if (live) setState({ status: 'error', error: String(failure?.message ?? failure) })
            },
          )
        return () => {
          live = false
        }
      }, [status, request])

      react.useEffect(() => {
        if (tab !== 'summaries') return undefined
        let live = true
        setSummary({ status: 'loading' })
        getJson(`${API}/summaries`).then(
          (value) => {
            if (live) setSummary({ status: 'ready', value })
          },
          (failure) => {
            if (live) setSummary({ status: 'error', error: String(failure?.message ?? failure) })
          },
        )
        return () => {
          live = false
        }
      }, [tab, request])

      const changeStatus = async (id, next) => {
        setBusy(true)
        setError('')
        try {
          await postJson(`${API}/set-status`, { id, status: next })
          setRequest((value) => value + 1)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      const refreshSummaries = async () => {
        setBusy(true)
        setError('')
        try {
          await postJson(`${API}/refresh`, {})
          setRequest((value) => value + 1)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      const tabs = [
        ['lessons', '经验'],
        ['summaries', '总结'],
      ]

      return jsx.jsxs('div', {
        className: 'pm-root',
        children: [
          jsx.jsxs('div', {
            className: 'pm-tabs',
            children: tabs.map(([id, label]) =>
              jsx.jsx(
                'button',
                {
                  type: 'button',
                  className: 'pm-tab',
                  'data-active': tab === id,
                  onClick: () => setTab(id),
                  children: label,
                },
                id,
              ),
            ),
          }),

          error !== '' ? jsx.jsx('p', { className: 'pm-error', role: 'alert', children: error }) : null,

          tab === 'lessons'
            ? jsx.jsxs(react.Fragment, {
                children: [
                  state.status === 'loading' ? jsx.jsx('p', { className: 'pm-muted', children: '加载中…' }) : null,
                  state.status === 'error'
                    ? jsx.jsxs('div', {
                        className: 'pm-row',
                        children: [
                          jsx.jsx('p', { className: 'pm-error', children: `读取失败：${state.error}` }),
                          jsx.jsx('button', {
                            type: 'button',
                            className: 'pm-btn',
                            onClick: () => setRequest((value) => value + 1),
                            children: '重试',
                          }),
                        ],
                      })
                    : null,
                  state.status === 'ready'
                    ? jsx.jsxs(react.Fragment, {
                        children: [
                          jsx.jsxs('div', {
                            className: 'pm-cards',
                            children: [
                              jsx.jsx(Card, { value: state.overview.total, label: '经验总数' }),
                              jsx.jsx(Card, { value: state.overview.byStatus.active, label: '活跃' }),
                              jsx.jsx(Card, { value: state.overview.byStatus.resolved, label: '已解决' }),
                              jsx.jsx(Card, { value: state.list.total, label: '当前筛选' }),
                            ],
                          }),
                          jsx.jsx('div', {
                            className: 'pm-muted',
                            children: `经验库：${state.overview.storeFile}`,
                          }),
                          jsx.jsxs('div', {
                            className: 'pm-row',
                            children: [
                              ['active', '活跃'],
                              ['resolved', '已解决'],
                              ['muted', '已忽略'],
                              ['all', '全部'],
                            ].map(([id, label]) =>
                              jsx.jsx(
                                'button',
                                {
                                  type: 'button',
                                  className: 'pm-tab',
                                  'data-active': status === id,
                                  onClick: () => setStatus(id),
                                  children: label,
                                },
                                id,
                              ),
                            ),
                          }),
                          state.list.lessons.length === 0
                            ? jsx.jsx('p', { className: 'pm-empty', children: '这个筛选下没有经验。' })
                            : jsx.jsxs('div', {
                                className: 'pm-root',
                                children: state.list.lessons.map((lesson) =>
                                  jsx.jsx(
                                    LessonItem,
                                    { lesson, busy, onStatus: changeStatus },
                                    lesson.id,
                                  ),
                                ),
                              }),
                        ],
                      })
                    : null,
                ],
              })
            : null,

          tab === 'summaries'
            ? jsx.jsxs(react.Fragment, {
                children: [
                  jsx.jsxs('div', {
                    className: 'pm-row',
                    children: [
                      jsx.jsx('button', {
                        type: 'button',
                        className: 'pm-btn',
                        disabled: busy,
                        onClick: refreshSummaries,
                        children: busy ? '生成中…' : '重新生成日/周总结',
                      }),
                      jsx.jsx('span', {
                        className: 'pm-muted',
                        children: '会话总结在会话结束时自动生成；日/周总结按天懒触发。',
                      }),
                    ],
                  }),
                  summary.status === 'loading' ? jsx.jsx('p', { className: 'pm-muted', children: '加载中…' }) : null,
                  summary.status === 'error'
                    ? jsx.jsx('p', { className: 'pm-error', children: `读取失败：${summary.error}` })
                    : null,
                  summary.status === 'ready'
                    ? jsx.jsxs(react.Fragment, {
                        children: [
                          jsx.jsx('h3', { children: '最近一次日总结' }),
                          summary.value.dailyText
                            ? jsx.jsx('div', { className: 'pm-pre', children: summary.value.dailyText })
                            : jsx.jsx('p', { className: 'pm-empty', children: '还没有日总结（当天没有捕获到失败）。' }),
                          jsx.jsx('h3', { children: '最近一次周总结' }),
                          summary.value.weeklyText
                            ? jsx.jsx('div', { className: 'pm-pre', children: summary.value.weeklyText })
                            : jsx.jsx('p', { className: 'pm-empty', children: '还没有周总结。' }),
                        ],
                      })
                    : null,
                ],
              })
            : null,
        ],
      })
    }

    const NS = 'settings.pitfallMemory'

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'pitfall-memory',
            order: 16,
            label: () => '踩坑记忆',
            locale: NS,
          },
          PitfallSettingsSection,
        ),
      )
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})