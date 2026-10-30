/**
 * 种子经验：首次运行时写入的一批「本机已知坑」。
 *
 * 来源是这台机器上反复验证过的事实（工作区 AGENTS.md / 环境审计），
 * 不依赖当前会话真的踩过。它们的作用是让插件装好后的第一次会话
 * 就有经验可用，而不是等坑再踩一遍。
 *
 * 这些条目带 `seed:` 前缀签名、`projects: ['*']`（全项目生效），
 * 并且和自动捕获的经验一样可以被 pitfall_resolve 标记或覆盖。
 */

const RT = String.raw`C:\Users\QQ\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies`

export function seedLessons() {
  return [
    {
      signature: 'seed:python-placeholder',
      category: 'runtime',
      title: 'PATH 上的 python / pip 是应用商店占位符',
      symptom: 'Python was not found; run without arguments to install from the Microsoft Store…（退出码 49）',
      advice: `不要用 python / python3 / pip。用捆绑解释器绝对路径：${RT}\\python\\python.exe；或先 source env-audit/env.sh 再用 py。`,
    },
    {
      signature: 'seed:python-encoding',
      category: 'encoding',
      title: 'Python 默认 GBK，读写 UTF-8 中文会炸',
      symptom: "UnicodeDecodeError: 'gbk' codec can't decode byte … / 写进管道的中文变成乱码",
      advice: '运行前设 PYTHONUTF8=1；文件读写显式 encoding="utf-8"（带 BOM 用 utf-8-sig）；中文计数别用 wc -m / cut -c（按字节），改用 py 或 grep -o .。',
    },
    {
      signature: 'seed:subprocess-pipe',
      category: 'runtime',
      title: '受限令牌下不能创建管道抓子进程输出',
      symptom: 'Python subprocess(capture_output/stdout=PIPE) 报 PermissionError [WinError 5]；Node spawnSync/execSync 报 EPERM',
      advice: '改用文件重定向（cap out.txt cmd）或 stdio:"inherit"；bash 自己的 | 和 $() 不受影响。',
    },
    {
      signature: 'seed:pip-locked',
      category: 'sandbox',
      title: 'pip 在本沙箱不可用',
      symptom: "ERROR: Could not install packages … Permission denied: '…\\Temp\\pip-unpack-*'",
      advice: '不要用 pip。改用 bash env-audit/pkg-install.sh -t /e/dsh/.pylibs <包名>，再 PYTHONPATH=/e/dsh/.pylibs 运行。',
    },
    {
      signature: 'seed:mkdtemp-locked',
      category: 'sandbox',
      title: 'mkdtemp / 0700 目录会永久锁死',
      symptom: 'tempfile.mkdtemp() 建出的目录之后不可读、不可写、不可删（连 icacls 都拒绝访问）',
      advice: '原生代码里不要用 tempfile.mkdtemp()。建目录用 os.makedirs(p, mode=0o777) 或让 bash mkdir 来建；已经产生的锁死目录只能由用户在普通会话里删除。',
    },
    {
      signature: 'seed:dsh-home-write',
      category: 'sandbox',
      title: 'DSH_HOME 与用户配置文件在工作区外，沙箱拒绝写',
      symptom: "EPERM: operation not permitted, mkdir 'C:\\Users\\QQ\\.dsh\\…' / 写 ~/.npmrc、~/.gitconfig 被拒",
      advice: '可写范围是工作区 E:\\dsh 与 /tmp。不要改 ~/.dsh、~/.npmrc、~/.gitconfig；确需修改时请用户授权放宽模式（插件安装这类一次性写 profile 可以申请 danger-full-access）。',
    },
    {
      signature: 'seed:git-identity',
      category: 'git',
      title: '本机没有全局 git 身份，commit 会失败',
      symptom: 'fatal: unable to auto-detect email address / Author identity unknown',
      advice: '提交时就地给身份：git -c user.name="dsh" -c user.email="dsh@local" commit -m "..."；或在仓库内 git config user.name/user.email（工作区可写）。',
    },
    {
      signature: 'seed:schannel-https',
      category: 'network',
      title: 'curl / PowerShell 的 HTTPS 拿不到 schannel 凭据',
      symptom: 'schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)',
      advice: 'HTTPS 一律用 Node（自带 TLS）：node env-audit/http.mjs <url>。HTTP 可以继续用 curl；PowerShell 5.1 的 Invoke-WebRequest 同样不可用。',
    },
    {
      signature: 'seed:network-reset',
      category: 'network',
      title: '网络会波动，raw.githubusercontent.com 不通',
      symptom: 'connect ECONNRESET / socket hang up（raw.githubusercontent.com）；同一目标偶发超时后又能通',
      advice: '下「某站不可达」结论前先重试 2 次。raw.githubusercontent.com 被重置，改用 github.com / codeload.github.com 或 npmmirror 镜像；google / duckduckgo 不可达。',
    },
    {
      signature: 'seed:npm-cache',
      category: 'sandbox',
      title: 'npm 缓存目录在沙箱外，npm 命令会失败',
      symptom: 'EACCES/EPERM 指向 C:\\Users\\QQ\\AppData\\Local\\npm-cache',
      advice: 'npm 命令加 --cache E:/dsh/.npm-cache；安装类任务优先用捆绑 pnpm：node <pnpm.mjs> install（store 在 E:\\dsh\\.pnpm-store）。',
    },
    {
      signature: 'seed:new-shell',
      category: 'runtime',
      title: 'ops_bash 每次都是全新 shell，环境不跨调用保留',
      symptom: '上一条命令 export 的变量/切到的目录，下一条命令里消失；PATH 与预期不同',
      advice: '每条命令自带前置（source env-audit/env.sh、cd 到目标目录、用绝对路径）；需要持久状态就写文件。',
    },
    {
      signature: 'seed:chained-commands',
      category: 'command',
      title: '串联命令里 cd 失败不会中断后续命令',
      symptom: 'cd /不存在: No such file or directory 之后，后面的 ls/cat 仍然在旧目录执行，结果读错文件',
      advice: '串联时用 cd <dir> && <cmd>（&& 保证失败即停）；不确定目录存在就先单独 test -d 或 ls。',
    },
    {
      signature: 'seed:node-test-spawn',
      category: 'runtime',
      title: 'Node 的 --test 运行器在受限令牌下 spawn EPERM',
      symptom: 'Error: spawn EPERM（node --test 启动子进程时报 errno -4048）',
      advice: '直接运行单个测试文件：node test/x.test.mjs；不要用会 spawn 子进程的 runner（jest/vitest 同样风险）。',
    },
    {
      signature: 'seed:long-path',
      category: 'runtime',
      title: '路径超过 260 字符（LongPathsEnabled=0）',
      symptom: 'ENAMETOOLONG / 文件名或扩展名太长',
      advice: '把中间目录改短（例如用 E:/dsh/tmp/x），或把项目移到更浅的路径；注册表本会话改不了。',
    },
  ].map((entry) => ({
    ...entry,
    id: `pm-${entry.signature.replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}`,
    severity: 3,
    occurrences: 1,
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    projects: ['*'],
    sessions: [],
    examples: [],
    source: 'seed',
    status: 'active',
  }))
}