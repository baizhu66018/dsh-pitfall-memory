# dsh-pitfall-memory · 中文说明

> 踩坑记忆：把每次会话里**真实发生过的失败**自动记下来，按「观察 → 经验 → 模式 → 规则」
> 四层收敛，并通过 **dynamic context** 随每轮请求注入经验简报，让同一个坑只踩一次。
> 同时按**会话 / 天 / 周**三个周期自动总结。

它不是 `AGENTS.md` 的替代品：`AGENTS.md` 是人手写的常驻规则，这个插件负责从运行日志里
**长出**那些规则还没覆盖到的坑，并把它们变成下次可用的经验与规则。

## 总结框架（四层收敛）

```
L1 观察 observation   一次失败的原始证据：命令、输出、退出码
        │  规则分类 + 签名归一化
L2 经验 lesson        同签名的「症状 + 正确做法」，occurrences 计数
        │  按根因族聚合
L3 模式 pattern       为什么总是这里出问题（受限令牌 / 沙箱边界 / 运行时解析…）
        │  取每条建议的首句，按严重度排序
L4 规则 rule          注入时最先展示的可执行清单
```

「根据经验调整总结框架」体现在三处：

- **根因族**比类别更接近原因：`python-pipe` / `pip-locked` / `mkdtemp-locked` 都归到「受限令牌」，
  `sandbox-denied` / `dsh-home-write` / `npm-cache-denied` 归到「沙箱边界」。
- **规则卡**不是另写一份文案，而是从经验里实时压出来的：每条经验取建议的首句，同一根因最多两条，
  经验更新，规则就跟着更新。
- **日/周总结**会给出「建议固化到 `AGENTS.md` 的规则」，把反复触发的模式提升为常驻规则。

## 三级总结

| 周期 | 触发 | 产物 |
| --- | --- | --- |
| 每次会话 | `agent/disposed` | `summaries/session-<id>.{json,md}`：本次捕获、新坑、复发 |
| 每天 | 会话开始 / 首次渲染简报懒触发 | `summaries/daily-YYYY-MM-DD.{json,md}`：根因排行、关键结论 |
| 每周 | 跨周后第一次触发 | `summaries/weekly-YYYY-Www.{json,md}`：7 天聚合、规则建议 |

周期调度是**懒触发**：`ensure()` 读 `state.json`，缺哪天补哪天，不常驻定时器。
日总结当天会随会话结束刷新；跨天后自动补上昨天的完整版。

## 它怎么工作

```
tool/call + tool/result（失败）
        │  规则分类 + 签名归一化
        ▼
  observation ──► observations.ndjson（原始证据）
        │  同签名合并计数
        ▼
  lessons.json ──► lessons.md（人可读）
        │  根因聚合 + 规则卡
        ▼
  systemPrompt.context ──► 经验简报（规则 → 最近一天 → 本周模式 → 其他高频坑）
        │                   随「Current runtime context」快照进入每轮请求
        ├─ 同会话再次踩到 → 追加一句提醒
        └─ 会话结束 → 会话总结；跨天/跨周 → 日总结、周总结
```

- **捕获**：监听 `session/event`，把 `tool/call` 的原始参数与 `tool/result` 的
  `isError` / `[exit code: N]` / `ERROR` 配对，交给规则表分类。
- **归并**：同一签名只保留一条经验，`occurrences` 累加，保留最近 3 条证据；
  已标记「已解决」的坑再次出现会自动复活。
- **注入**：注册 `systemPrompt.context({ name: 'pitfall:briefing' })`，宿主每轮装配时读取。
  这是官方 `sandbox-policy` / `user-approval` / `subagent` 都在用的通道，内容和
  「Current runtime context」一起进入模型请求。
  **踩过的坑**：最初用 `agent/pre-step` 返回新 messages，心跳显示注入执行了、2055 字符，
  但会话日志里一条 plugin 消息都没有——构造了不等于被采纳。改用 dynamic context 后立刻可见。
- **可观测**：`apply` / 渲染 / 捕获 / 总结的关键事件写入 `<store>/.heartbeat.jsonl`，
  「到底加载了没有、为什么没注入」直接看文件，不用猜。
- **工具**：模型可以查看、补充、标记经验，复盘会话，生成日/周总结。

## 内置能认出的坑

首次运行（经验库为空）时会先写入 14 条**种子经验**——它们是这台机器上反复验证过的事实
（`python` 是应用商店占位符、`subprocess(PIPE)` 报 `WinError 5`、`~/.dsh` 不可写、
`raw.githubusercontent.com` 不通……），所以装好后的第一次会话就能看到经验，不用先踩一遍。
种子只在库为空时写入一次，之后由自动捕获继续累积。

自动规则表覆盖本机最常踩的类别（全部来自真实报错）：

| 类别 | 例子 |
| --- | --- |
| `sandbox` | 写 `~/.dsh`、`C:\`、`D:\` 被拒；pip 的 `pip-unpack-*` 权限失败；`mkdtemp` 目录锁死 |
| `runtime` | PATH 上的 `python` 是应用商店占位符；`subprocess(PIPE)` 报 `WinError 5`；命令不存在；路径超 260 字符 |
| `encoding` | Python 默认 GBK，读 UTF-8 中文 `UnicodeDecodeError` |
| `git` | 全局 `user.name/email` 缺失，`git commit` 失败 |
| `network` | `curl`/PowerShell 的 `SEC_E_NO_CREDENTIALS`；`ECONNRESET`；`raw.githubusercontent.com` 不通 |
| `tooling` | `UNKNOWN_TOOL`；工具返回结构化错误 |
| `command` | 任意非零退出码，按「命令首词 + 稳定错误行」归类 |

识别不了的失败会落到 `tool-error` / `nonzero-exit` 兜底，不会丢。

## 安装

```bash
# 1. 预览
node scripts/install.mjs --dry-run

# 2. 安装（复制到 profile/node_modules，并加入 dsh.profile.bundles）
node scripts/install.mjs

# 3. 重启 DSH
```

安装脚本是幂等的：重复运行会刷新文件，不会重复加 bundle。
默认装进 `desktop` profile；用 `--profile` / `--home` 指定别的。

卸载：从 `<profile>/package.json` 的 `dsh.profile.bundles` 删掉 `dsh-pitfall-memory`，
删除 `<profile>/node_modules/dsh-pitfall-memory`，再删除 `<profile>/.dsh-pitfall-memory/`（可选，删了经验就没了）。

## 配置

行配置在 `cordis.patch.yml`（插件自带一份默认值；可在 profile 的 `cordis.patch.yml`
里按 id `pitfall-memory` 覆盖）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `seed` | `true` | 首次运行写入本机已知坑的种子经验 |
| `summaries` | `true` | 会话/日/周三级总结 |
| `capture` | `true` | 自动捕获工具失败 |
| `inject` | `true` | 每次会话第一次 pre-step 注入简报 |
| `maxLessons` | `12` | 简报里「高频坑」最多几条 |
| `maxInjectBytes` | `6000` | 简报 UTF-8 字节上限 |
| `minOccurrences` | `1` | 出现几次才注入 |
| `injectIntoSubagents` | `false` | 是否给子代理会话注入 |
| `repeatWarn` | `true` | 同会话重复踩坑时追加一句话提醒 |
| `projectScoped` | `true` | 只注入本项目 + 全局经验 |
| `maxFindingsPerSession` | `200` | 单会话最多记录多少条失败 |
| `maxLessonsStored` | `300` | 经验库保留上限（种子/手动经验不淘汰） |
| `storeDir` | 空 | 存储目录；空 = `<profile>/.dsh-pitfall-memory` |
| `captureTools` | `[]` | 只捕获这些工具（空 = 全部） |
| `debug` | `false` | 额外日志 |

## 存储

默认 `<profile>/.dsh-pitfall-memory/`：

| 文件 | 内容 |
| --- | --- |
| `lessons.json` | 结构化经验库（唯一真相） |
| `lessons.md` | 人可读清单，可直接翻看或粘进 `AGENTS.md` |
| `observations.ndjson` | 原始失败证据（追加写，超 1 MB 轮转） |
| `state.json` | 周期总结的进度（lastDaily / lastWeekly） |
| `summaries/` | 会话、日、周总结（json + md） |
| `.heartbeat.jsonl` | 加载与注入心跳（排查「为什么没生效」的第一站） |

经验按项目归属：项目根取「向上找到的第一个含 `.git` / `AGENTS.md` 的目录」。
`scope: global` 的经验在所有项目注入。

## 工具

| 工具 | 用途 |
| --- | --- |
| `pitfall_list` | 查看经验（按状态/类别/项目过滤） |
| `pitfall_remember` | 把本次会话总结的「根因 + 正确做法」写进库 |
| `pitfall_resolve` | 标记已解决 / 忽略 / 重新激活 |
| `pitfall_review` | 复盘当前会话：新坑、重复坑、已解决又复发，附根因族 |
| `pitfall_summary` | 生成/查看会话、日、周总结 |

收尾建议：会话里踩了坑时，直接调用 `pitfall_review`，再按需要 `pitfall_remember`
把结论固化；需要看趋势时调用 `pitfall_summary`（`period: day` / `week`）。

## Web 设置页

插件带一个浏览器半身，在 **设置 → 插件 → 踩坑记忆** 里打开：

- **经验** tab：总量/活跃/已解决卡片，按状态筛选，每条可展开看症状与做法，
  并可「重新激活 / 标记已解决 / 忽略」。
- **总结** tab：最近的日总结与周总结全文，附「重新生成日/周总结」按钮。

实现方式（两个半身，走普通契约）：

| 半身 | 文件 | 职责 |
| --- | --- | --- |
| host | `lib/index.js` + `lib/settings-api.js` | 用 `webServer.register` 挂 `/dsh-pitfall-memory/api/*` 五个 JSON 端点 |
| client | `lib/client.js` | `window.__ModuleLoader__` bundle，注册 `settings.section` slot |

`package.json` 里两处声明缺一不可：

```json
"exports": { "./client": "./lib/client.js" },
"dsh": { "client": { "platform": "web", "inject": ["slots"] } }
```

> ⚠️ **设置页必须重启 DSH 才会出现。** `dsh-client-modules` 只在进程启动时扫描
> `dsh.client` 声明；改 profile 的 user patch 触发的热重载不会重新扫描，
> 效果是「host 侧 API 已经通了（`grep` 心跳有 `settings-api-mounted`），
> 但界面里还没有这一页」。

接口一览（只读为主，两个写操作）：

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/dsh-pitfall-memory/api/overview` | GET | 条数、状态分布、规则卡、心跳 |
| `/dsh-pitfall-memory/api/list` | GET | 经验列表（`?status=` / `?category=`） |
| `/dsh-pitfall-memory/api/summaries` | GET | 最近日/周总结 |
| `/dsh-pitfall-memory/api/set-status` | POST | `{ id, status }` |
| `/dsh-pitfall-memory/api/refresh` | POST | 重算日/周总结 |

安全：与 dsh-market 同一条纪律——请求带 `Origin` 头时必须匹配环回 `Host`，
否则 403；无 `Origin`（Node fetch、本机代理）视为可信。

> 为什么不用 Typert Remote：`@Remote()` 是标准 method decorator，而本机 Node 24
> 直接执行 ESM 时不支持装饰器语法（官方包都是编译产物）。普通 HTTP 路由不需要构建步骤。

## 验证

```bash
# 纯 Node 单元 + 集成冒烟测试（不依赖 DSH 运行时）
node test/detect.test.mjs
node test/store.test.mjs
node test/render.test.mjs
node test/summary.test.mjs
node test/smoke.test.mjs
node test/settings-api.test.mjs   # 设置页后端：投影、路由、Origin 校验
node test/client.test.mjs         # 浏览器 bundle：导出、slot 注册、组件渲染

# 安装与经验库自检
node scripts/doctor.mjs
```

> 注意：本机受限令牌下 `node --test test/` 会因 spawn 子进程报 `EPERM`，请直接
> 运行单个测试文件（如上）。

装好并重启后，可以这样确认在工作：

1. 发一条消息，界面顶部（runtime context 快照里）应出现「🕳️ 本机经验简报」；
2. 跑一条会失败的命令（例如 `python --version`），看 `lessons.json` 是否多了一条；
3. 结束会话后看 `summaries/session-*.md`；第二天再看 `summaries/daily-*.md`。

排查不生效时的顺序：先看 `.heartbeat.jsonl` 有没有 `apply-ok`（加载了吗）→
再看有没有 `context-render`（渲染了吗）→ 最后看 `lessons.json` 里是否有 `projects`
包含当前项目的活跃经验（有东西可注入吗）。

## 设计取舍

- **规则而不是 LLM**：捕获、归类、四层收敛、三级总结都是确定性的、零成本的、离线的；
  LLM 只在模型自己决定调用 `pitfall_*` 工具时参与，避免插件偷偷花钱和拖慢会话。
- **注入走 dynamic context**：宿主每轮装配时读取，晚安装、重启恢复都成立；
  内容随 runtime context 快照一起进入请求，不需要改写历史消息。
- **失败隔离**：所有事件回调都包 `try/catch`；经验库或总结写失败只会打日志，绝不影响会话。
- **项目隔离**：别的项目的经验默认不注入，避免「张冠李戴」的误导。