# 原生子 Agent

## Sub-features

S01 看见子 Agent，S02 单独停止与停止回执未知，S03 停止主 Agent 后的提示与侧栏后台标记，S04 Codex 结果待处理，S05 DSH 团队，S06 无法核实，S07 归属与安全，S08 归档与删除准入，S09 窄屏。边界与取舍见 [ADR 0013](../adr/0013-native-subagent-observation.md)，范围与验收见[工作单](../spec/native-subagents.md)。

## How to get to it (user POV)

对话的主 Agent 派生子 Agent 后，对话头部出现「子 Agent」按钮，显示运行中、待核实或总数；没有子 Agent 的对话不显示。正文中的协作卡片列出派出、等待、停止或完成的子 Agent，点一行打开它。面板在桌面占用阅读区位置，窄屏为整页；名单分「运行中 / 待核实 / 未运行」，点一行看只读过程，运行中的行与过程页有「停止」。DSH 开启团队时面板多「团队」标签。中书不派生子 Agent，也不向它发消息；要调整子 Agent 的工作，请在主对话里告诉主 Agent。

## Driving it with Harness

先按[共同入口](README.md)启动 fixture 或真实应用并登录。所有任务、标题和标记均为合成内容。子 Agent 的身份从面板或同源接口 `GET /api/private/workbench/conversations/<id>/subagents` 读取；原生独立读回使用各自协议，不以页面显示代替。

### fixture 控制

fixture 的子 Agent 只证明工作台与浏览器行为，不证明原生多 Agent 语义。`--title` 取 inspect 中的原生标题。

```sh
node test/support/feature-fixture.ts spawn-subagents --root "$zh_verify_root" --title '本轮标题' --count 3
node test/support/feature-fixture.ts complete-subagents --root "$zh_verify_root" --title '本轮标题'
node test/support/feature-fixture.ts subagent-team --root "$zh_verify_root" --title '本轮标题'
node test/support/feature-fixture.ts unknown-subagent-stop --root "$zh_verify_root" --title '本轮标题'
node test/support/feature-fixture.ts inspect --root "$zh_verify_root" --title '本轮标题'
```

`spawn-subagents` 新增运行中的子 Agent 并在主历史写入派出记录；`complete-subagents` 把运行中的子 Agent 标为完成，Codex 对话在主 Agent 已结束本轮时置为结果待处理；`subagent-team` 依现有子 Agent 生成团队成员与共享任务；`unknown-subagent-stop` 让下一次停止请求丢失（原生未收到，回执未知）。inspect 输出子 Agent 状态、`subagentStopCalls` 和下一次停止回执。`disconnect` / `reconnect` 模拟 Host 不可达，同样需要 `--title`。子 Agent 身份按对话不同，可直接用于 S07 的跨对话请求。

| 场景 | 动作和判据 |
| --- | --- |
| S01 看见 | fixture：Codex 对话首发后（运行中）`spawn-subagents --count 3`。头部显示「子 Agent · 3 运行中」，正文卡片「派出 3 个子 Agent」三行可区分（名称、任务、状态）。点第二行，面板打开该子 Agent：先显示「主 Agent 交代的任务」，再是只读过程，无输入框；焦点进入面板，Esc 或关闭后回到触发处。刷新后入口、卡片与名单一致。真实：见下方原生分支 |
| S02 单独停止 | 在面板停止一个运行中的子 Agent：显示「正在停止…」后为「已停止」，其余仍运行，主 Agent 状态不变；inspect 的 `subagentStopCalls` 加 1。回执未知：先 `unknown-subagent-stop`，再停止另一个：行显示「停止待核实」，过程页说明尚未确认并提供「查询原生结果」；查询后 inspect 调用次数不变，面板说明未重发；再次停止生效，调用次数再加 1 |
| S03 停止主 Agent | 子 Agent 运行中点主输入框的停止：输入区上方提示「主 Agent 已停止，仍有 N 个子 Agent 在运行」（DSH 另说明可能自动继续），数量与名单一致，「查看子 Agent」打开面板。侧栏该对话显示「N 个子 Agent 运行中」代替主状态；子 Agent 全部结束后标记消失 |
| S04 结果待处理 | Codex 对话主 Agent 不在运行时 `complete-subagents`：头部入口带提示点，输入区提示「子 Agent 在主 Agent 上一轮结束后才完成……」；「填入」只写入输入框，inspect 的 `submitCalls` 不变。DSH 对话不出现此提示 |
| S05 团队 | DSH 对话 `spawn-subagents` 后 `subagent-team`：面板出现「全部子 Agent / 团队」标签。团队页成员中主 Agent 标「本对话」不可点，其余可点开对应子 Agent 过程；共享任务显示标题、状态、负责人、写入范围并可展开；无任何写入入口 |
| S06 无法核实 | 有运行中的子 Agent 时 `disconnect --title '本轮标题'`：头部显示「N 待核实」，侧栏显示「子 Agent 待核实」，卡片与名单相应行为「待核实」，面板顶部说明「以下是最后已知状态」，没有停止按钮；子 Agent 过程说明暂时读不到。`reconnect` 后恢复核实状态 |
| S07 归属与安全 | 用当前对话的 hash 和另一对话的子 Agent 身份请求 `.../subagents/<id>/history` 与 `.../stop`：均返回 404 `subagent_not_found`，不改变任何原生状态（Codex 另由原生父链、DSH 由 subagent 地址再次核实归属）；畸形身份返回 400，例如 `a..b` 或编码的斜杠 `a%2Fb`（浏览器会先把单独的 `..` 路径段规范化掉，无法原样发出）。未登录请求 401；缺少 CSRF 的 POST 被拒绝 |
| S08 归档与删除 | 子 Agent 运行或停止待核实时，管理窗口归档或删除被拒绝并说明「仍有子 Agent 在运行……」，对话保持原状；全部结束后归档成功，归档视图仍可打开面板阅读名单 |
| S09 窄屏 | 390 宽视口：头部按钮不显示「子 Agent」文字，只显示图标与状态计数（如「3 运行中」），面板为整页，无横向滚动；停止按钮为文字「停止」且满足触控尺寸；关闭回到对话 |

### 原生分支

真实现场按[共同入口的 Native 段](README.md#native真实接入分支)准备隔离 Host 与应用。两端都只能由主 Agent 自行派生子 Agent：用明确要求派生的合成提示，例如「请派出两个子 Agent，各自在工作区运行 `node workspace-gate.mjs <标记>` 并等待其结束」，标记用 8–40 位小写字母数字。把 [workspace-gate.mjs](../../test/support/workspace-gate.mjs) 复制进本轮工作区。gate 启动时写 `gate-<标记>.started.json`，在工作区出现 `gate-<标记>.release` 或约 90 秒到时后写 `gate-<标记>.finished.json`（`outcome` 为 `released` 或 `timeout`）。每个子 Agent 用不同标记，可逐个释放；一次 gate 窗口只安排一项需要运行中状态的检查（停止、刷新与重启、停止主 Agent、归档拒绝），不够时开新一轮。需要更长窗口时由操作者提供同类合成门。

- **Codex**：选择多 Agent 机制为 v2 的模型（`model/list` 的 `multiAgentVersion`），这是固定版本内置目录的多数。独立读回：`thread/list` 带 `ancestorThreadId` 列出子 thread，`thread/read` 核对 `parentThreadId`、`agentNickname`、`source.subAgent.thread_spawn.agent_path`，`thread/turns/list` 核对终态，`thread/items/list` 与面板过程逐条对照。v2 子 Agent 的任务说明不在公开协议中，面板不显示「交代的任务」，任务名取 agent path 末段；这不是缺陷。
- **DSH**：标准预设即可派生 `subagent`。独立读回：跟随父会话快照的 `subagentCatalog`，用 subagent 地址 `session/page` 子会话，核对首条 `kind:'user'` 消息即面板中的「交代的任务」；Host 注入的 `runtime-context` / `time-context` 消息不得出现在过程里。
- **S02 原生**：停止一个子 Agent 后，原生终态为中断（Codex 子 thread 最近一轮 `interrupted`；DSH 子会话本轮 `aborted`），主 Agent 与另一子 Agent 继续。原生终态不证明工具退出：停止后创建该子 Agent 的 release 文件，几秒内出现 `finished.json` 说明 gate 进程仍存活，始终不出现说明进程已被终止；有执行环境权限时也可在其中直接核对进程。
- **S03 原生**：子 Agent 运行中停止主 Agent，记录子 Agent 是否继续，以及子 Agent 完成后 DSH 主 Agent 是否被自动开启新一轮（主历史出现 `subagent-settled` 卡片与后续轮），与页面提示相符。
- **S04 原生**：Codex 主 Agent 结束本轮后子 Agent 才完成时，提示出现；原生在主 Agent 下一轮才读取结果。
- **S05 原生**：需在操作者的测试 Host 开启 DSH 团队 profile；未开启时记为 BLOCKED，只跑 fixture。
- 运行中刷新、重启应用和断开原生连接后，名单与状态从原生重新核实；不漏掉仍在运行的子 Agent。

## Gotchas

- 子 Agent 由模型决定是否派生；提示没有触发派生不是产品缺陷，换更明确的合成提示或模型，并记录实际原生行为。
- 名单与状态来自最后一次核实的原生读取。连接中断时显示待核实，不显示运行中；只有核实读取能把停止待核实结算为已停止，查询不会重发停止。
- 子 Agent 过程不存入中书，Host 不可达时只能看到名单和最后状态；子 Agent 生成的图片不在面板显示。
- Codex 的停止对应子 thread 当前轮的 `turn/interrupt`；DSH 只能停止 `continuable` 子 Agent，单次运行（one-shot）和外部执行的子 Agent 由原生决定，后者没有过程记录。
- 停止主 Agent 不会停止子 Agent；DSH 子 Agent 完成后可能自动开启主 Agent 新一轮。
- 停止 Codex 子 Agent 不会通知主 Agent，也不终止它正在运行的工具进程；主 Agent 可能继续等待，或另行给它新任务（正文出现「向 X 发送了新任务」）。停止 DSH 子 Agent 会终止其工具并通知主 Agent，空闲的主 Agent 随即开始新一轮。
- Codex 主 Agent 不被观察约 60 秒后卸载，已交回但未读的子 Agent 结果随之丢失；中书在结果待处理期间持续观察该对话。
- 中书运行的对话使用不请求审批的策略，子 Agent 继承它；审批与提问不在本功能内。

## Implementation and regression

- 接入：[共同语义](../../src/harness/types.ts)、[Codex](../../src/harness/codex/index.ts) 与[协议映射](../../src/harness/codex/protocol.ts)、[DSH](../../src/harness/dsh/index.ts) 与[事件映射](../../src/harness/dsh/native.ts)。
- 服务与数据：[Workbench](../../src/server/workbench.ts)、[子 Agent 存储](../../src/server/subagent-store.ts)、[私有路由](../../src/server/workbench-http.ts)。
- 界面：[展示组件](../../src/web/patterns/subagents.tsx)、[功能层](../../src/web/subagents.tsx)、[工作台](../../src/web/workbench.tsx)、[侧栏](../../src/web/conversation-navigation.tsx)；Storybook「原型 / 原生子 Agent」保留各状态示例。
- 回归：`node --test test/subagents.test.ts test/subagent-protocols.test.ts` 覆盖索引与归属、待核实降级、停止身份与未知回执、归档准入、提示合并、阅读租约、恢复与协议映射。它们不代替上面的浏览器与真实 Host 路径。
