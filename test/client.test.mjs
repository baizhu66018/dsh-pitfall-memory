/**
 * 设置页 client bundle 测试：模拟浏览器 __ModuleLoader__ 加载，验证
 * 模块导出、slot 注册与组件渲染都不依赖真实浏览器。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const BUNDLE = path.resolve(import.meta.dirname, '..', 'lib', 'client.js')

/** 最小 React 替身：只提供组件用到的 API。 */
function reactStub() {
  return {
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useId: () => 'id',
    useMemo: (fn) => fn(),
    Fragment: 'Fragment',
  }
}

const jsxStub = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
}

/** 在隔离环境里加载 bundle 并返回导出模块。 */
function loadBundle() {
  const src = readFileSync(BUNDLE, 'utf8')
  let captured
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = { __ModuleLoader__: { load: (module) => { captured = module } } }
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
  }
  try {
    new Function('window', src)(globalThis.window)
    assert.ok(captured, 'bundle 应调用 __ModuleLoader__.load')
    const requireStub = (name) => {
      if (name === 'react') return reactStub()
      if (name === 'react/jsx-runtime') return jsxStub
      throw new Error(`未知依赖：${name}`)
    }
    return { captured, module: captured.factory(requireStub) }
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  }
}

/** 递归收集渲染树里的文本节点。 */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (node.props?.children !== undefined) collectText(node.props.children, out)
  return out
}

test('bundle 导出 apply / inject / NS', () => {
  const { captured, module } = loadBundle()
  assert.equal(captured.id, 'dsh-pitfall-memory')
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['slots'])
  assert.equal(module.NS, 'settings.pitfallMemory')
})

test('apply 注册 settings.section', () => {
  const { module } = loadBundle()
  const injected = []
  const registered = []
  module.apply({
    slots: {
      inject(name, callback) {
        injected.push(name)
        callback()
      },
      register(definition, component) {
        registered.push({ definition, component })
        return () => {}
      },
    },
  })

  assert.deepEqual(injected, ['settings.section'])
  assert.equal(registered.length, 1)
  const { definition, component } = registered[0]
  assert.equal(definition.name, 'settings.section')
  assert.equal(definition.id, 'pitfall-memory')
  assert.equal(definition.order, 16)
  assert.equal(definition.label(), '踩坑记忆')
  assert.equal(typeof component, 'function')
})

test('组件能渲染出两个 tab', () => {
  const { module } = loadBundle()
  const registered = []
  module.apply({
    slots: {
      inject: (_name, callback) => callback(),
      register: (definition, component) => {
        registered.push({ definition, component })
        return () => {}
      },
    },
  })
  const tree = registered[0].component({})
  const texts = collectText(tree)
  assert.ok(texts.some((text) => text.includes('经验')), `应包含「经验」tab，实际：${texts.slice(0, 8)}`)
  assert.ok(texts.some((text) => text.includes('总结')), `应包含「总结」tab，实际：${texts.slice(0, 8)}`)
  assert.ok(texts.some((text) => text.includes('加载中')), '初始应显示加载状态')
})