/**
 * 失败识别与归类。
 *
 * 输入是「一次工具调用 + 它的结果文本」，输出是一条观察（observation）：
 * 归到哪个坑、签名是什么、症状与正确做法是什么。纯函数，不碰 IO。
 *
 * 规则顺序即优先级：越具体的坑放越前，通用兜底放最后。
 */
import { clip, meaningfulLines, stripAnsi } from './util.js'

/** 类别元信息（渲染与筛选用）。 */
export const CATEGORY_META = {
  sandbox: { label: '沙箱与权限', icon: '🔒' },
  runtime: { label: '运行时与命令', icon: '⚙️' },
  encoding: { label: '编码与中文', icon: '🈶' },
  network: { label: '网络与凭据', icon: '🌐' },
  git: { label: 'Git', icon: '🌿' },
  tooling: { label: '工具与工作流', icon: '🧰' },
  command: { label: '命令失败', icon: '❗' },
}

const EXIT_CODE = /\[exit code:\s*(\d+)\]/i
const EXIT_MARK = /\[EXIT_CODE\b/i

/** 是否算失败：isError、结构化错误、非零退出码，任一命中。 */
export function isFailure({ isError, errorInfo, text }) {
  if (isError) return true
  if (errorInfo) return true
  const exit = EXIT_CODE.exec(String(text ?? ''))
  if (exit && Number(exit[1]) !== 0) return true
  return EXIT_MARK.test(String(text ?? ''))
}

/** 提取退出码（没有则 undefined）。 */
export function exitCodeOf(text) {
  const match = EXIT_CODE.exec(String(text ?? ''))
  return match ? Number(match[1]) : undefined
}

/** 首条「像错误」的行，用于症状展示。 */
export function firstErrorLine(text) {
  const lines = meaningfulLines(text)
  const patterns = [
    /error|exception|fatal|failed|failure|cannot|can't|denied|refused|not found|no such|unable/i,
    /WinError|EPERM|EACCES|ECONN|ETIMEDOUT|ENOTFOUND|SEC_E_|PermissionError|Unicode/i,
    /\[exit code:\s*[1-9]/i,
    /\[EXIT_CODE\b/i,
  ]
  for (const pattern of patterns) {
    const hit = lines.find((line) => pattern.test(line))
    if (hit) return hit.trim()
  }
  return lines[0]?.trim() ?? ''
}

/** 症状：错误附近最多若干行，截断到 400 字。 */
function symptomOf(text) {
  const lines = meaningfulLines(text)
  if (lines.length === 0) return '（无输出）'
  const index = lines.findIndex((line) => line === firstErrorLine(text))
  const start = Math.max(0, index >= 0 ? index - 1 : 0)
  const slice = lines.slice(start, start + 4).map((line) => line.trim())
  return clip(slice.join(' ⏎ '), 400)
}

/** 把错误行归一化成可做签名的稳定片段。 */
export function stableErrorLine(text) {
  let line = firstErrorLine(text)
  if (!line) return 'unknown'
  line = line
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<time>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/line \d+/gi, 'line <n>')
    .replace(/:\d+:\d+/g, ':<n>')
    .replace(/\b\d{3,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
  return clip(line, 80)
}

/** 从文本里找第一个盘符/根路径，取前两段作为作用域签名。 */
export function pathScope(text) {
  const match = /((?:[A-Za-z]:[\\/]|\/[a-z]\/)[^\s"'`<>|:]+)/i.exec(String(text ?? ''))
  if (!match) return 'generic'
  const raw = match[1].replace(/\\/g, '/')
  const parts = raw.split('/').filter(Boolean)
  return parts.slice(0, 2).join('/').toLowerCase() || 'generic'
}

/** 命令首词（bash 命令、或工具参数里的 command）。 */
export function commandHead(text) {
  const source = meaningfulLines(text).join('\n')
  const first = source.split('\n').find((line) => line.trim() !== '') ?? ''
  const token = first.trim().split(/\s+/u)[0] ?? ''
  return token.replace(/^["']|["']$/g, '').split('/').pop() ?? ''
}

/** 从 URL 里取主机。 */
function hostOf(text) {
  const match = /https?:\/\/([^\s/'"`]+)/i.exec(String(text ?? ''))
  return match ? match[1].toLowerCase() : 'network'
}

function has(text, pattern) {
  return pattern.test(String(text ?? ''))
}

/**
 * 规则表。`test` 返回签名 key（非空字符串即命中），空字符串表示命中但无细分。
 * `advice` 是「下次正确做法」，专为本机环境写。
 */
export const RULES = [
  {
    id: 'python-placeholder',
    category: 'runtime',
    severity: 3,
    title: 'PATH 上的 python 是应用商店占位符',
    test: (text) =>
      has(text, /Python was not found|Microsoft Store|python3?[^\n]*not recognized|python\.exe.*App Execution Aliases/i)
        ? 'windows-store-alias'
        : '',
    advice:
      '不要调用 python / python3 / pip。用捆绑 Python 绝对路径：C:\\Users\\QQ\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe，或先 `source env-audit/env.sh` 再用 py。',
  },
  {
    id: 'python-pipe',
    category: 'runtime',
    severity: 3,
    title: '受限令牌下不能创建管道抓子进程输出',
    test: (text) =>
      has(text, /subprocess|spawnSync|execSync|os\.pipe|check_output|capture_output|PIPE/i) &&
      has(text, /WinError 5|EPERM|Permission denied|拒绝访问/i)
        ? 'subprocess-pipe'
        : '',
    advice:
      '不要在 Python/Node 里用 subprocess(PIPE)、check_output、spawnSync/execSync 抓输出。改用文件重定向（cap out.txt cmd）或 stdio:"inherit"；bash 自己的管道与 $() 正常。',
  },
  {
    id: 'pip-locked',
    category: 'sandbox',
    severity: 3,
    title: 'pip 在本沙箱不可用（临时目录 ACL 不匹配）',
    test: (text) =>
      has(text, /pip-unpack|pip-install|pip\.exe|pip3|No matching distribution|Could not find a version/i) &&
      has(text, /Permission|denied|EACCES|EPERM|WinError 5|拒绝访问|Read timed out/i)
        ? 'pip'
        : '',
    advice:
      '不要用 pip。改用：bash env-audit/pkg-install.sh -t /e/dsh/.pylibs <包名>，再 PYTHONPATH=/e/dsh/.pylibs 运行。',
  },
  {
    id: 'mkdtemp-locked',
    category: 'sandbox',
    severity: 3,
    title: 'mkdtemp/0700 目录会永久锁死',
    test: (text) =>
      has(text, /mkdtemp|mode 0700|0o700/i) && has(text, /Permission|denied|拒绝/i) ? 'mkdtemp' : '',
    advice:
      '原生代码里不要用 tempfile.mkdtemp()。建目录用 os.makedirs(p, mode=0o777) 或让 bash mkdir 来建；已产生的锁死目录只能由用户在普通会话删除。',
  },
  {
    id: 'python-encoding',
    category: 'encoding',
    severity: 2,
    title: 'Python 默认 GBK，读写 UTF-8 中文会炸',
    test: (text) => {
      if (has(text, /Unicode(?:Decode|Encode)Error|codec can't (?:decode|encode)|'gbk' codec|cp936/i)) {
        const codec = /(gbk|cp936|utf-8|gb18030)/i.exec(text)
        return codec ? codec[1].toLowerCase() : 'codec'
      }
      return ''
    },
    advice:
      '运行 Python 前设 PYTHONUTF8=1；文件读写显式 encoding="utf-8"（带 BOM 用 utf-8-sig）；中文计数别用 wc -m / cut -c（按字节），改用 py 或 grep -o .。',
  },
  {
    id: 'dsh-home-write',
    category: 'sandbox',
    severity: 3,
    title: 'DSH_HOME 与用户配置文件在工作区外，沙箱拒绝写',
    test: (text) =>
      has(text, /Permission|denied|EACCES|EPERM|WinError 5|拒绝访问|PATH_RESTRICTED/i) &&
      has(text, /\.dsh|\.npmrc|\.gitconfig|npm-cache|profiles[\\/]/i)
        ? has(text, /\.npmrc/i)
          ? 'npmrc'
          : has(text, /\.gitconfig/i)
            ? 'gitconfig'
            : 'dsh-home'
        : '',
    advice:
      '不要写 ~/.dsh、~/.npmrc、~/.gitconfig、C:/、D:/ 根目录；可写范围是工作区 E:\\dsh 与 /tmp。确需修改这些文件时，请用户授权放宽模式，或让用户手工改。',
  },
  {
    id: 'npm-cache-denied',
    category: 'sandbox',
    severity: 2,
    title: 'npm 缓存目录在沙箱外，npm 命令会失败',
    test: (text) =>
      has(text, /npm\b|npx\b/i) &&
      has(text, /Permission|denied|EACCES|EPERM|npm-cache|WinError 5|拒绝访问/i) &&
      has(text, /npm-cache|AppData/i)
        ? 'npm'
        : '',
    advice:
      'npm 命令加 --cache E:/dsh/.npm-cache；安装类任务优先用捆绑 pnpm：node <pnpm.mjs路径> install（store 已在 E:\\dsh\\.pnpm-store）。',
  },
  {
    id: 'sandbox-denied',
    category: 'sandbox',
    severity: 3,
    title: '写入/访问工作区外路径被沙箱拒绝',
    test: (text) =>
      has(text, /Permission denied|EACCES|EPERM|WinError 5|Access is denied|PATH_RESTRICTED|denied by (?:policy|sandbox)|沙箱.*拒/i)
        ? pathScope(text)
        : '',
    advice:
      '写操作只落在工作区 E:\\dsh 或 /tmp；读取一般不受限。需要越界写入时不要换 shell 绕，先向用户申请放宽模式。',
  },
  {
    id: 'git-identity',
    category: 'git',
    severity: 2,
    title: '本机没有全局 git 身份，commit 会失败',
    test: (text) =>
      has(text, /Author identity unknown|unable to auto-detect email|empty ident|Please tell me who you are|Committer identity unknown/i)
        ? 'commit'
        : '',
    advice:
      '提交时就地给身份：git -c user.name="dsh" -c user.email="dsh@local" commit -m "..."; 或在仓库内 git config user.name/user.email（工作区可写）。',
  },
  {
    id: 'schannel-https',
    category: 'network',
    severity: 2,
    title: 'curl/PowerShell 的 HTTPS 拿不到 schannel 凭据',
    test: (text) =>
      has(text, /SEC_E_NO_CREDENTIALS|schannel|AcquireCredentialsHandle|Invoke-WebRequest.*失败/i)
        ? 'schannel'
        : '',
    advice:
      'HTTPS 一律用 Node（自带 TLS）：node env-audit/http.mjs <url>。HTTP 可继续用 curl；PowerShell 5.1 的 Invoke-WebRequest 同样不可用。',
  },
  {
    id: 'network-reset',
    category: 'network',
    severity: 2,
    title: '网络请求被重置或超时',
    test: (text) =>
      has(text, /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|timed? ?out/i)
        ? hostOf(text)
        : '',
    advice:
      '先重试 2 次再下结论（网络会波动）。raw.githubusercontent.com 不通，改用 github.com / codeload.github.com 或 npmmirror 镜像；google/duckduckgo 不可达。',
  },
  {
    id: 'long-path',
    category: 'runtime',
    severity: 2,
    title: '路径超过 260 字符（LongPathsEnabled=0）',
    test: (text) => (has(text, /ENAMETOOLONG|path too long|文件名或扩展名太长/i) ? 'path' : ''),
    advice: '把中间目录改短（例如用 E:/dsh/tmp/x），或把项目移到更浅的路径；注册表项本会话改不了。',
  },
  {
    id: 'unknown-tool',
    category: 'tooling',
    severity: 2,
    title: '调用了不存在或被限制的工具',
    test: (text) => {
      if (!has(text, /UNKNOWN_TOOL|Tool not found|unknown tool|工具不存在/i)) return ''
      const name = /[Tt]ool\s+["'`]?([\w.:-]+)/.exec(text)
      return name ? name[1].toLowerCase() : 'unknown'
    },
    advice:
      '先确认工具在当前会话可见（工具列表会随 preset/发现机制变化）；需要时用 ops_discover_tools 查找，或退回已发布的等价工具。',
  },
  {
    id: 'command-not-found',
    category: 'runtime',
    severity: 2,
    title: '命令不存在或不在 PATH 上',
    test: (text) =>
      has(text, /command not found|not recognized as an internal|无法将.*识别为|No such file or directory|不是内部或外部命令/i)
        ? commandHead(text) || 'command'
        : '',
    advice:
      'ops_bash 每次都是全新 shell，PATH/shell 变量不跨调用保留；用运行时绝对路径，或先 `source env-audit/env.sh`。',
  },
  {
    id: 'nonzero-exit',
    category: 'command',
    severity: 2,
    title: '命令以非零退出码结束',
    test: (text) => {
      const code = exitCodeOf(text)
      if (code === undefined || code === 0) return ''
      return `${commandHead(text) || 'command'}|${stableErrorLine(text)}`
    },
    advice:
      '读 stderr 与退出码定位原因，不要原样重试同一条命令；先确认路径、运行时与权限，再换一种做法。',
  },
  {
    id: 'tool-error',
    category: 'tooling',
    severity: 1,
    title: '工具执行返回错误',
    // 用工具名 + 首条错误行做签名：不同工具/不同错误要分开统计，
    // 否则所有未识别失败会挤成一条没有信息量的「工具报错」。
    test: (text, context) =>
      context.isError ? `${context.toolName || 'tool'}|${stableErrorLine(text)}` : '',
    advice: '查看错误原文与参数，按错误码定位；同一参数不要重复调用，先修正前置条件。',
  },
]

/**
 * 把一次工具结果归类。
 * @param {object} input
 * @param {string} input.toolName 工具名
 * @param {string} [input.command] 命令文本（bash 类工具）
 * @param {string} input.text 结果文本
 * @param {boolean} [input.isError] 结构化错误标记
 * @param {{name?:string,code?:string}} [input.errorInfo] 会话日志里的错误身份
 * @returns {null | object} observation
 */
export function classify({ toolName, command = '', text, isError = false, errorInfo }) {
  const raw = stripAnsi(text)
  if (!isFailure({ isError, errorInfo, text: raw })) return null

  const context = { isError: Boolean(isError || errorInfo), toolName }
  for (const rule of RULES) {
    const key = rule.test(raw, context)
    if (key === '' || key === undefined) continue
    return {
      ruleId: rule.id,
      category: rule.category,
      title: rule.title,
      severity: rule.severity,
      key: String(key),
      signature: `${rule.category}:${rule.id}:${String(key)}`,
      symptom: symptomOf(raw),
      advice: rule.advice,
      toolName: String(toolName ?? ''),
      command: clip(command || commandHead(raw), 200),
      exitCode: exitCodeOf(raw),
      at: new Date().toISOString(),
    }
  }
  return null
}

/** 从原始事件里提取结果文本（tool/result 的 content 可能是多块）。 */
export function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((block) => (block && block.type === 'text' ? String(block.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

export { symptomOf }