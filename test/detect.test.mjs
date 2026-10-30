/**
 * 失败识别测试：覆盖本机最常踩的几类坑，全部取自真实输出片段。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classify, exitCodeOf, firstErrorLine, isFailure, stableErrorLine } from '../lib/detect.js'

function obs(input) {
  return classify({ toolName: 'ops_bash', command: 'python --version', text: '', isError: false, ...input })
}

test('成功输出不算失败', () => {
  assert.equal(obs({ text: 'hello\n[exit code: 0]' }), null)
  assert.equal(isFailure({ isError: false, text: 'all good' }), false)
})

test('非零退出码算失败', () => {
  assert.equal(isFailure({ isError: false, text: '[exit code: 1]' }), true)
  assert.equal(exitCodeOf('x\n[exit code: 49]'), 49)
})

test('python 占位符', () => {
  const result = obs({
    text: 'Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut...\n[exit code: 49]',
  })
  assert.equal(result.ruleId, 'python-placeholder')
  assert.equal(result.category, 'runtime')
  assert.match(result.advice, /bundled|捆绑|dsh-primary-runtime/i)
})

test('受限令牌下的管道失败', () => {
  const result = obs({
    text: 'Traceback ...\nsubprocess.CalledProcessError ...\nPermissionError: [WinError 5] Access is denied',
    isError: true,
  })
  assert.equal(result.ruleId, 'python-pipe')
  assert.match(result.advice, /cap|stdio|重定向/i)
})

test('pip 被人为锁死', () => {
  const result = obs({
    text: "ERROR: Could not install packages due to an OSError: [Errno 13] Permission denied: 'C:\\\\Users\\\\QQ\\\\AppData\\\\Local\\\\Temp\\\\pip-unpack-abc'",
    isError: true,
  })
  assert.equal(result.ruleId, 'pip-locked')
  assert.match(result.advice, /pkg-install\.sh/)
})

test('Python GBK 编码错误', () => {
  const result = obs({
    text: "UnicodeDecodeError: 'gbk' codec can't decode byte 0xe4 in position 0: illegal multibyte sequence",
    isError: true,
  })
  assert.equal(result.ruleId, 'python-encoding')
  assert.equal(result.category, 'encoding')
  assert.match(result.advice, /PYTHONUTF8/)
})

test('DSH_HOME 写入被拒（比通用权限更具体）', () => {
  const result = obs({
    text: "bash: line 1: /c/Users/QQ/.dsh/test.txt: Permission denied\n[exit code: 1]",
  })
  assert.equal(result.ruleId, 'dsh-home-write')
  assert.equal(result.category, 'sandbox')
})

test('通用沙箱拒绝带路径作用域签名', () => {
  const result = obs({
    text: "cp: cannot create regular file '/d/work/x.txt': Permission denied\n[exit code: 1]",
  })
  assert.equal(result.ruleId, 'sandbox-denied')
  assert.ok(result.signature.includes('d/work'), result.signature)
})

test('git 身份缺失', () => {
  const result = obs({
    text: '*** Please tell me who you are.\n\nfatal: unable to auto-detect email address\n[exit code: 128]',
  })
  assert.equal(result.ruleId, 'git-identity')
  assert.match(result.advice, /user\.name/)
})

test('schannel 凭据失败', () => {
  const result = obs({
    text: 'curl: (58) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)\n[exit code: 58]',
  })
  assert.equal(result.ruleId, 'schannel-https')
})

test('网络重置', () => {
  const result = obs({
    text: 'Error: connect ECONNRESET 185.199.108.133:443\n    at TLSSocket.onConnectSecure',
    isError: true,
  })
  assert.equal(result.ruleId, 'network-reset')
  assert.match(result.advice, /重试|raw\.githubusercontent/)
})

test('工具名不存在', () => {
  const result = obs({ text: 'UNKNOWN_TOOL: Tool "bash" is not registered', isError: true })
  assert.equal(result.ruleId, 'unknown-tool')
})

test('命令不存在', () => {
  const result = obs({ text: 'bash: line 1: rg: command not found\n[exit code: 127]' })
  assert.equal(result.ruleId, 'command-not-found')
})

test('通用非零退出兜底', () => {
  const result = obs({
    text: '[stderr]\nsomething exploded\n[EXIT_CODE; effects: unknown; retry: after-input-change]\n[exit code: 2]',
  })
  assert.equal(result.ruleId, 'nonzero-exit')
  assert.equal(result.exitCode, 2)
})

test('结构化错误即使文本正常也归类为工具错误', () => {
  const result = obs({ text: 'weird but no keyword', isError: true })
  assert.equal(result.ruleId, 'tool-error')
})

test('症状与签名稳定化', () => {
  const text = "Error: EACCES: permission denied, open 'C:\\Users\\QQ\\.dsh\\x'\nat 2026-10-30T03:04:05.123Z"
  assert.match(firstErrorLine(text), /permission denied/i)
  assert.match(stableErrorLine(text), /<time>|<n>|permission/i)
})