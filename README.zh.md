# dsh-codex-subagent

<p align="center"><img src="icon.svg" width="96" height="96" alt="dsh-codex-subagent icon"></p>

[English](README.md) | 中文

把本机的 [Codex CLI](https://github.com/openai/codex) 接成 DSH（DeepSeek Harness）里
**可查看过程的子智能体**。装了它，DSH 的模型就能像调用官方的 Codex / Claude Code 子智能体
一样，把一项开发任务派给 Codex，拿回它的最终回答；事后还能在 DSH 里点开这次派活，看到任务
原文、Codex 的思考与回复、它执行的命令与输出，以及结束状态。

插件自己注册 `codex` 工具，每次调用起一个 `codex-dev` 子进程。子会话在进程启动之前就建好，
Codex 的 `--json` NDJSON 事件流按行边收边投影：一次 Codex turn 一个 step，命令调用带结果，
思考与回复原样保留，时间戳是真的；父会话的目录行同样在任务开始时追加，所以任务还在跑，子会话
就已经出现在 DSH 的子智能体目录里，点开是只读历史。

和官方 [`@deepseek-ai/dsh-subagent-codex`](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-codex)
（工具名 `subagent_codex`）的区别：本插件的子会话**可点开**、**可续接**（把返回的 id 传回来，
Codex 自己的 thread 继续用）、**有日志**（summary 或 full，另加派活记录）。两者不要同时作为
编码后端启用：那样模型会看到两个互相竞争的 Codex 工具。

## 薄壳：只做两件事

怎么跑 Codex，插件几乎不管，全由 `codex-dev` 决定：

1. 每次一个私有 `CODEX_HOME`——插件运行时是 `<sessionDir>/home`，单独调用封装时是临时目录——
   所以 `~/.codex` 永远不会被写；
2. 把用户的 `config.toml` 与 `auth.json` 复制进这个私有目录（登录凭据权限 `600`）；
   `config.toml` 每次运行都覆盖；
3. 凭据交接：环境里已有 `DEEPSEEK_API_KEY` 就用它；否则有复制进来的 `auth.json`
   （来自 `codex login`）就够；再否则从 `~/.pi/agent/auth.json` 读 DeepSeek key 放进环境变量
   （不打印、不落盘）；
4. 把固定规矩（`rules/CODEX-DEV-RULES.md`）拼在任务说明前面；
5. 不钉模型：复制的 `config.toml` 里写的就是要用的模型，所以一次派活和交互式 `codex` 用同一个
   模型（`--model` / `CODEX_DEV_MODEL` 可以覆盖）；
6. 沙箱策略（新 thread 用 `-s <mode>`，续接用 `-c sandbox_mode=<mode>`）和可选的绕过开关；
7. Codex 自己的会话存储放在私有 `CODEX_HOME` 下，所以 thread 可以被续接；
8. 用 `--log` 把完整输出复制一份到文件（插件只在 `logMode: "full"` 时要求）；
9. 跑完往派活记录里追加一行。

插件自己只做两件事：

1. **跑这次派活**：校验参数，把任务说明写进临时目录，直接起 `codex-dev`
   （用 `node:child_process`），stdout 按行增量解析、stderr 只留尾部做诊断，取消时先
   SIGTERM、宽限期后 SIGKILL，最终回答取 Codex 最后一条 `agent_message`；
2. **边跑边投影**：先创建一个真实的 DSH 子会话（`sessions.prepare` +
   `sessionPersistence.create` + `enter`/`announce`），在起进程之前追加开场事件和父会话的
   `subagent/catalog` 目录行；然后每收到一条 Codex 记录就追加对应事件：一次 Codex turn 一对
   `step/start`…`step/end`、`assistant/message`（思考/文本/工具调用块）、每次命令执行一对
   `tool/call` + `tool/result`，最后 `turn/end` 写真实结束原因；收尾 flush 两个会话（保留的
   子会话不 detach、不关句柄，留给下一次复用，插件卸载时统一释放）。

插件不 import 任何 `@deepseek-ai/*` 包，也没有运行时依赖，只用 `node:` 内置模块。
`tools`、`sessions`、`sessionPersistence` 由 DSH 注入。投影每一步都是尽力而为：服务缺失或
追加被拒时只记一条 warn，派活结果照常返回。

### 自带 `codex-dev` 封装

`bin/codex-dev` 是作者本机那套封装，插件只认它的契约：`--brief`、`--cwd`、`--log`、
`--model`、`--thinking`、`--mode text|json`（插件总是传 `--mode json`）、`--session-id`、
`--session-dir`、`--sandbox`、`--bypass`，最后原样追加 `config.args`；stdout 是回答
（JSON 模式下是事件流），退出码决定成功与否。想用自带封装，就把它复制到
`~/.dsh/bin/codex-dev`，在那儿建软链（封装会先解析自己的软链，包里的规矩文件照样找得到），
或者把 `command` 配成包里的 `bin/codex-dev`。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `CODEX_BIN` | `codex`（走 `PATH`） | 要跑的 Codex 可执行文件。 |
| `CODEX_DEV_RULES` | `<封装真实目录>/../rules/CODEX-DEV-RULES.md` | 拼在任务说明前的固定规矩。 |
| `CODEX_HOME_SRC` | `$HOME/.codex` | 从哪个用户安装复制 `config.toml`/`auth.json`。 |
| `CODEX_DEV_RECORD_DIR` | `$HOME/.dsh` | 派活记录目录，写 `codex-delegations.log`。 |
| `CODEX_DEV_MODEL` | 空 | 默认 `--model`；空表示「用 `config.toml` 里的」。 |
| `CODEX_DEV_SESSION_DIR` | `$HOME/.dsh/codex-sessions` | 带 `--session-id` 但没给 `--session-dir` 时的 Codex 状态根目录；两者都没有时，单独调用封装用临时目录。 |

## 要求

- **Node.js** `^22.19.0 || >=24.0.0`，**DSH** `>= 0.2.2-rc.1`。
- 本机装了 **Codex CLI**，能当 `codex` 用（或通过 `CODEX_BIN` 指定）。这里的实测版本是
  codex-cli **0.168.0**；JSON 事件格式属于 Codex 自己，版本之间可能变化。
- **一个可用凭据**，三种任选其一：
  - 环境变量里的 `DEEPSEEK_API_KEY`（优先级最高）；
  - 做过 `codex login`，即 `~/.codex/auth.json` 存在（会被复制进私有 `CODEX_HOME`，
    插件随即走 Codex 原生登录）；
  - 用 `pi auth login deepseek` 存过 DeepSeek key（从 `~/.pi/agent/auth.json` 读出，
    只给子进程的环境变量）。

  三者都没有时封装退出 `2`，错误信息把三条路都写清楚。任何 key 都不会被打印。

## 安装

这个包是 DSH bundle：`package.json` 里声明了 `dsh.bundle.patch = ./cordis.patch.yml`。
装上包就够了，patch 会把插件挂上（`id: subagent-codex-cli`、`name: dsh-codex-subagent`），
它自己注册 `codex` 工具、自己投影子会话，网页「插件 → 已安装插件」里也会出现它的卡片。

```bash
# 从 npm 装
dsh plugin --profile web add dsh-codex-subagent

# 从 GitHub 装
dsh plugin --profile web add git+https://github.com/A1311981684/dsh-codex-subagent.git

# 从本地目录装
dsh plugin --profile web add file:/path/to/dsh-codex-subagent
```

也可以把它写进 profile 的 `~/.dsh/profiles/<名字>/package.json`，让 profile 从自己的
`node_modules` 里找：

```json
{
  "dependencies": {
    "dsh-codex-subagent": "file:/path/to/dsh-codex-subagent"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-codex-subagent"]
    }
  }
}
```

装完重启 DSH（或者等 HMR 重载），模型就多了一个 `codex` 工具。
只要 `codex-dev` 自己能找到凭据，就不需要额外的环境变量。

想自己手写挂载、顺手配几个参数，就把下面这段加到 profile 的 `cordis.patch.yml`。
一行就够：插件自己注册 `codex` 工具。

```yaml
- insert:
    - id: subagent-codex-cli
      name: dsh-codex-subagent
      config:
        # command: /usr/local/bin/codex-dev
        # sandbox: workspace-write
        # logDir: /home/me/.dsh/codex-logs
        # logMode: summary
        # sessionDir: /home/me/.dsh/codex-sessions
        # graceMs: 5000
        # projection: true
```

## 配置

所有配置项都可以不填，bundle patch 一个都不传。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `command` | `$HOME/.dsh/bin/codex-dev` | 要跑的封装。放别处就改这里。 |
| `args` | `[]` | 追加在最后的额外参数。 |
| `model` | — | 填了就传 `--model`；不填由 `config.toml` 决定。 |
| `thinking` | — | 填了就传 `-c model_reasoning_effort=<档位>`（`codex exec` 与 `codex exec resume` 都接受）。 |
| `projection` | `true` | 把每次派活投影成 DSH 子会话。`false` 只跑派活、照写日志。 |
| `labelPrefix` | `codex · ` | 加在每个新子会话 label 前面的前缀，方便在面板里和其他后端的记录区分。设成 `''` 就关掉。只影响之后新建的记录；已有记录不变。 |
| `logMode` | `summary` | `summary`（默认）插件自己写精简日志；`full` 让封装 tee 完整输出（`--log`），JSON 模式下就是原始事件流，可能几十 MB。 |
| `logDir` | `$HOME/.dsh/codex-logs` | 日志放这里，文件名是 `<YYYYMMDD-HHmmss>-<id 前 8 位>.log`。 |
| `sessionDir` | `$HOME/.dsh/codex-sessions` | Codex 状态根目录，作为 `--session-dir` 传入；运行用 `<sessionDir>/home` 当 `CODEX_HOME`。 |
| `graceMs` | `5000` | 取消子进程时的 SIGTERM → SIGKILL 宽限期（毫秒）。 |
| `maxOutputBytes` | `262144` | 保留的 stderr 尾部与原始 stdout 兜底在内存里的上限，超了留尾部。 |
| `sandbox` | `workspace-write` | `read-only`、`workspace-write` 或 `danger-full-access`；新 thread 传 `-s`，续接传 `-c sandbox_mode=…`。 |
| `dangerouslyBypass` | `false` | **危险开关。** 为 `true` 时追加 `--dangerously-bypass-approvals-and-sandbox`，Codex 不受任何限制地跑。除非进程本身已经被外部沙箱包住，否则别开。 |

配置在挂载时就检查，配错当场报错，不会拖到第一次派活。规则：`graceMs` 和
`maxOutputBytes` 必须是正有限数，`command`、`logDir`、`sessionDir` 必须是非空字符串，
`logMode` 只能是 `"summary"` 或 `"full"`，`sandbox` 只能取上面三种，`args` 必须是字符串
数组，`projection`/`dangerouslyBypass` 必须是布尔，`labelPrefix` 必须是不含控制字符的字符串（可以为空）。

## 工具

插件只注册一个工具 `codex`：

- `prompt`（必填）——完整、自足的任务说明；Codex 看不到父会话的上下文；
- `cwd`（可选）——绝对工作目录，必须存在；不填用调用方会话的工作目录；
- `label`（可选）——子会话在 DSH 子智能体列表里显示的名字；不填取 `prompt` 第一行非空文本
  并加上 `labelPrefix`，最多 60 字（前缀计入）。显式传 `label` 也加前缀，但不截断；
- `session`（可选）——之前某次调用返回的子会话 id，用来接着干。

工具返回值是 `{ output, childSessionId, session, logPath, stopReason }`，失败时多一个
`diagnostic`。模型看到的文字是：最终回答、可选的诊断、`subagent session: <id>` 一行、
`to continue this delegation, pass session: <id>` 提示、`full output: <日志路径>` 一行。
`stopReason` 是 `completed`、`error` 或 `aborted`。

子会话 id 只在开出它的那个宿主进程里能续。DSH 重启后插件会返回清楚的错误
（`session <id> is not continuable in this host process; omit session to start a new one`），
不会悄悄当新任务跑。

## 会话投影

`projection: true`（默认）时，每次派活还会生成一个真实的 DSH 子会话，**先建子会话、再起
Codex**：

1. `sessions.prepare(childId, { meta })`，meta 带子会话的 `cwd`、`parentSession`、
   `origin: 'subagent'`、`delegationDepth`（父的 + 1），然后
   `sessionPersistence.create(session.header, { inheritedEventCount: 0 })`、写掉发布前的
   事件尾巴、`enter`、`announce`——和 `dsh-agent-loop` 里一样的顺序；
2. 进程还不存在时先追加开场事件：`turn/start`（DSH 的第 1 个 turn）、`subagent/descriptor`
   （第 3 版，`mode: 'one-shot'`，`provider: 'codex'`，带 label）、任务原文 `user/message`；
   紧接着追加父会话的 `subagent/catalog` 目录行（第 0 版），于是 Codex 刚开工目录里就有这一行；
3. stdout 按行增量解析（半行自己缓冲；单行超过 2 MiB 直接丢弃并 warn），每条记录映射成事件：
   - `thread.started` → 这次运行的 Codex thread id（续接用）；
   - `turn.started` → `step/start`：**一次 Codex turn 就是一个 DSH step**；
   - `item.started`（`command_execution`）→ 一条带 `tool-call` 块的 `assistant/message`，
     加上配对的 `tool/call`，两处参数串完全一致；
   - `item.completed`（`command_execution`）→ `tool/result`，带聚合输出与错误状态；
   - `item.completed`（`agent_message`）→ 带文本块的 `assistant/message`，最后一条就是返回给
     父会话的回答；
   - `item.completed`（`reasoning`）→ 带 `reasoning` 块的 `assistant/message`；
   - `item.completed`（`error`）→ 非致命告警：记日志、留在精简日志里，绝不因此判失败；
   - `item.updated` → 不投影（只是进度细化）；
   - `turn.completed` → 记下 usage 汇总，然后 `step/end`；
   - `turn.failed` 或顶层 `error` → 标记运行失败，然后 `step/end`；
4. 最后 flush 两个会话；子会话保留为 live（不 detach、写句柄不关），下一次调用可以直接追加
   新 turn，插件卸载时统一释放。

这个顺序不是好看：持久化日志回读时会逐条校验关系。`step/end` 时若还有已登记未结算的
`tool/call` 会被拒；`turn/end` 时若还有打开的 step 会被拒；`tool/call` 的参数串必须和
`tool-call` 块里的字符串一模一样；`step` 号必须在打开的 turn 里从 1 连续递增。正常结束、
失败、取消都走同一个收尾函数，所以日志总是括号配对、并有一个 `turn/end`。Codex 的原始事件流
不会进入父会话，父会话只多一条 `subagent/catalog` 目录行。

**降级。** 投影是尽力而为的，永远不会影响派活本身：

- `sessions`/`sessionPersistence` 缺失，或者 `prepare`/`create`/开场追加被拒：记一条 `warn`，
  结果照常返回，`childSessionId` 为空；
- 运行中某次追加被拒：记一条 `warn`，后续内容不再投影，但仍会补上结构性收尾
  （`step/end`、`turn/end`）；
- 封装打的是纯文本而不是 NDJSON：不重跑，整段 stdout 当唯一一条助手消息，投影仍记录任务原文
  和结束状态；
- 非零退出或 `turn.failed`：`stopReason: 'error'`，诊断是 stderr 尾部（最多 4096 字节）；
  干净退出但一条 `agent_message` 都没有也算错误，因为这个工具承诺返回回答。

## 会话复用

每个 `codex` 结果都带 `session`（子会话 id）。下一次调用把它传回来就是续跑：

- 同一个 DSH 子会话追加一个新 turn（编号 = 已记录的最后一个 turn + 1），带自己的任务原文和
  自己的 step 编号；不会再写 `subagent/descriptor`，也不会再写父会话的 `subagent/catalog`；
- `codex-dev` 用 `--session-id <thread_id> --session-dir <sessionDir>` 起进程，Codex 自己的
  thread 继续用——读过的文件、做过的决定、工具历史都还在，一般更省 token；新派活同样会带
  `--session-dir`（每次运行都带），所以它的 thread 存在 `<sessionDir>/home` 下，之后也能续；
- `thread_id`（来自 `thread.started`）就是续接 id，只存在插件进程内的登记表里；子会话和它的
  写句柄一直保留到下一次续跑或插件卸载；
- 同一个 session 同一时间只能跑一个任务；并发调用会报 `session <id> is already running`；
- 某次运行没报 thread id 的会话不能续，插件会直接说清楚，不会静默当新任务跑。

`codex exec resume` 不接受 `-C/--cd`，也不接受 `-s/--sandbox`，所以续接沿用 thread 创建时
记录的工作目录；沙箱由封装用 `-c sandbox_mode=<mode>` 传。用 codex-cli 0.168.0 实测过：一条
用 `-s read-only` 创建的 thread，续接时加 `-c sandbox_mode=workspace-write` 后仍然写得动文件，
所以这个配置覆盖**确实**对续接生效。这是那一版的实测结论，不是文档保证。

## 行为细节与限制

- **私有 `CODEX_HOME`。** 插件每次运行用 `<sessionDir>/home` 当 `CODEX_HOME`（权限 `700`），
  里面是从用户目录复制的 `config.toml`（每次覆盖）和 `auth.json`（存在才复制，权限 `600`）。
  因此 `~/.codex` 不会被写——代价是这些 thread 在终端的 `codex resume` 列表里看不到：
  它们住在插件自己的状态目录里，不在 `~/.codex`。
- **不投影的 item 类型。** `file_change`、`mcp_tool_call`（以及 Codex 以后新增的类型）每类
  只 `warn` 一次就跳过：不影响派活，也不在子会话里显示成工具调用。只有命令执行会被投影成
  工具调用。
- **输出上限。** 单行 stdout 超过 2 MiB 整行丢弃并 `warn`；`maxOutputBytes` 限制保留的
  stderr（和原始 stdout 兜底）长度，超了留尾部。
- **没有超时。** 插件不按自己的时间表杀进程：它一直等子进程，只有调用方取消
  （`exec.signal`）才会停——先 SIGTERM，宽限期后 SIGKILL，子会话的 turn 收成 `aborted`。
- **子会话没有独立 Stop。** 网页把子会话当只读历史展示；只有主对话里取消这次派活才能中止。
- **沙箱依赖 bubblewrap。** Codex 的 `workspace-write`/`read-only` 沙箱在 Linux 上依赖
  bubblewrap 和 user namespace；宿主不支持时是 Codex 自己的沙箱失败（插件不改变这一点）。
  `danger-full-access` 或 `dangerouslyBypass` 能绕开，代价是真隔离没有了。
- **label 带后端前缀。** 新开的子会话 label 以 `labelPrefix`（默认 `codex · `）开头，这样在 DSH
  子智能体面板里能一眼把 Codex 的记录和 Pi（`pi · `）、Claude Code（`claude · `）的分开。续接沿用
  开号时的 label，已有记录不会被改写。
- **一个 session 同时只跑一个任务**；除此之外每次新派活互不干扰：自己的临时任务说明文件
  （失败也删）、自己的子会话 id、自己的进程状态。

## 安全

每次派活只起一个本机 `codex` 进程，用私有 `CODEX_HOME`；插件本身没有运行时依赖、
没有安装脚本、也没有联网代码。

- 凭据只放进子进程环境；复制进私有 `CODEX_HOME` 的 `~/.codex/auth.json` 权限是
  `600`，`~/.codex` 永远不会被写。
- 默认沙箱是 `workspace-write`；`dangerouslyBypass` 要显式打开，文档里标了危险。
- 日志和派活记录里有任务文本和命令输出，`$HOME/.dsh/codex-logs` 请按敏感数据处理。
- Codex 子进程会继承 DSH 宿主进程的环境，和在终端里直接跑 `codex` 一样。

完整说明和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 日志与清理

`logMode`（默认 `summary`）决定一次派活往
`<logDir>/<YYYYMMDD-HHmmss>-<id 前 8 位>.log` 写什么：

- `summary`——插件自己写：任务首行（最多 100 字）、最终回答全文、每条命令一行
  `tool <name> <durationMs>ms <ok|error>`，最后一行是汇总 usage（`input`/`output`/
  `cacheRead`/`cacheWrite`/`reasoning`）、`stopReason`、子会话 id 和 Codex thread id；
  非致命 Codex 告警以 `note …` 行附在后面。一般几 KB。
- `full`——封装 tee Codex 的完整输出（`--log`），JSON 模式下就是原始事件流，长任务可能几十 MB。

`summary` 模式下工具返回的 `logPath` 在写失败时为空；`full` 模式下它就是交给封装的那个路径。
旧日志不会自动删：

```bash
node scripts/cleanup.mjs [--days 14] [--dry-run] [--sessions]
```

默认删除 `$HOME/.dsh/codex-logs` 下超过 N 天的文件，打印删除数量和释放空间；`--dry-run`
只列不删。`--sessions` 额外**列出**（绝不删除）旧的 Codex thread 候选：即
`<sessionDir>/home/sessions/**` 下的 `*.jsonl` rollout 文件，`sessionDir` 默认
`$HOME/.dsh/codex-sessions`，可用 `CODEX_DEV_SESSION_DIR` 覆盖。删掉某个 thread 会破坏
引用它的 DSH 子会话的续接，所以脚本只打印这条警告，什么都不删。

## 开发与自测

```bash
cd dsh-codex-subagent
node --check lib/index.js
bash -n bin/codex-dev
node --test test/            # 58 个单元测试，全绿，不联网、不花模型调用
node test/real-codex.mjs     # 手动跑：两次真 Codex（创建 + 续接），花费很小
```

- `test/tool.test.js` 用假 `ctx`（`tools.register`、`sessions`、`sessionPersistence`、
  `logger`）挂插件，跑真的子进程：`test/fake-codex-dev.mjs` 被复制到临时根目录当 `command`，
  从任务说明里读 `FIXTURE`/`RECORD` 指令，于是每个用例都能控制子进程的 stdout、stderr、
  退出码和时长，同时逐字断言插件拼的 argv、写的 brief、追加的子会话事件。覆盖：工具注册与
  schema、argv 拼装、参数与 `cwd` 校验、投影的事件顺序与 payload（描述符 v3、目录 v0、step
  括号、reasoning/text/tool-call 块、`tool/call` 与 `tool/result` 配对、usage 映射）、多轮
  step 编号、纯文本与空 stdout 降级、error / abort 结束状态、SIGKILL 升级、服务缺失与追加
  被拒降级、超长行、并发隔离、配置校验、HOME 派生的默认值、临时目录清理、精简/完整日志、
  会话复用、未知和并发 `session`、卸载时释放句柄。
- `test/codex-dev.test.js` 用假 `CODEX_BIN` 跑自带封装，检查 Codex 的 argv（新建 vs.
  `exec resume`、模型/思考等级/沙箱/绕过）、私有 `CODEX_HOME` 与复制进去的文件、默认与
  覆盖的会话目录、临时状态目录、三条凭据路径（含 `codex login` 分支）、绝不打印 key、
  `--log`、派活记录、参数校验。
- `test/cleanup.test.js` 用临时 `$HOME` 跑 `scripts/cleanup.mjs`：`--dry-run` 不删、
  `--days` 筛选、删除时保留新文件、`--sessions` 只列不删（默认目录与
  `CODEX_DEV_SESSION_DIR` 两种布局）。
- `test/real-codex.mjs` 是手动端到端：用真 `codex-dev` 跑两次，第一次建文件并执行命令，
  第二次把第一次的 `thread.started` id 作为 `--session-id` 传回去，必须续上同一个 thread。
  它没有 DSH 容器，所以顺带验证「投影不可用 → 只 warn、继续返回」这条降级路径。
  `NODE_TEST_CONTEXT` 已设置时直接跳过，所以 `node --test` 不会白花模型调用。
- `test/index.js` 只是入口。有些 Node 版本把 `node --test` 后面的位置参数当模块路径，
  不写成它就跑不到测试。等价写法是 `node --test test/*.test.js`。

## 许可

[MIT](LICENSE) © 2026 Asta Zhao
