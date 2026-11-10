# 执行与停止：feature map

本页覆盖发送、停止、排队、提前发送、回答 Agent 的提问与审批，以及 Plan 模式。图文与引用的完整行为见[对话基本可用性](conversation-usability.md)。发送与恢复约定见 [ADR 0004](../adr/0004-recoverable-communication.md)，原生语义见 [ADR 0001](../adr/0001-native-harness-boundary.md)。

## Sub-features

| 场景 | 要证明的行为 |
| --- | --- |
| E01 | 发送进入同一对话；接收回执不等于本轮完成 |
| E02 | 原生结果未知时核对原操作，不重复派发 |
| E03 | 停止指向当前轮，显示中断及后台工具限制；之后可接续 |
| E04 | 无法保留发送编号时不派发；明确拒绝后保留可编辑输入 |
| E05 | 两个真实 Harness 分别读写文件、同会话回忆，并核验真实停止 |
| E06 | 两端的持久多条队列、编辑删除、逐条提前发送与暂停恢复 |
| E07 | 点击后换轮、原生回执未知及原编号核对 |
| E08 | DSH 主 Agent 的结构化提问在任何权限下出现在输入框上方；一次回答生效，其他设备同步显示已回答；应用重启后未答问题仍可回答 |
| E09 | 审批只在工作区读写与只读时出现，按钮与原生给出的决定一致；完全访问不出现审批；Codex 子 Agent 的审批标明来源 |
| E10 | 回答回执未知时不重发；原生仍在等待则重新打开，原生已不等待则显示已失效（[ADR 0016](../adr/0016-questions-and-approvals.md)） |
| E11 | Plan 开关：两端都在输入框工具栏，运行中不能切换，各设备一致；开着时显示说明条 |
| E12 | Codex Plan：Plan 中的结构化提问按官方格式回答；计划显示为计划块，本轮后出现“计划已就绪”，按计划执行即关闭 Plan 并开始默认模式的一轮 |
| E13 | DSH Plan：开关执行原生命令并以原生状态为准；计划审核卡片可批准或附意见继续规划，批准后原生退出 Plan 并继续执行 |

## How to get to it (user POV)

首次发送从[工作区草稿](conversations.md)进入；已有对话路径为：进入配置已核实的对话 →“给 Agent 的消息”→“发送消息”，或 ⌘/Ctrl + Enter。Enter 换行。支持排队的对话运行时，输入动作改为“加入队列”，旁边保留“停止当前轮”。消息队列贴在输入框上方，每行右侧的图标按钮对应“编辑”“删除”和该对话支持的“追加到本轮”或“尽快发送”。未知状态可见“查询原生结果”，未确认草稿可见“核对同一发送”。

## Driving it with Harness

先完成 [共同入口](README.md) 和 C01。fixture 收到文本后保持运行，只有 CLI complete 或页面停止会到终态；这样无需靠消息长度或固定 sleep 猜测运行窗口。

| 场景 | 初始条件与动作 | 判据和独立观察 |
| --- | --- | --- |
| E01 | 建“执行 A”，输入含本轮独有标记的两行文本；先按 Enter，再发送。CLI complete 后输入新文本再发送 | Enter 不派发；首次发送 inspect 的 submitCalls=1、正文有两行用户输入、出现停止按钮。complete 后出现 `FIXTURE COMPLETED <runId>`、恢复发送，再发后 submitCalls=2；两轮同原生身份、配置不变。运行中快捷键的排队行为见 E06 |
| E02 | 按 [空原生会话故障前提](conversations.md#空原生会话故障前提) 建“未知回执”；先运行 unknown-receipt，再发送唯一文本。保存产品操作 ID、inspect 调用数；在“核对同一发送”重试两次；再运行 prove，点“查询原生结果” | 未发布证据前，操作 unknown、保留 pending 草稿，同编号重试不增加 submitCalls。发布后 accepted，草稿中的 pending 被清除；inspect 始终只调用一次，原生 operationIds 只有原 ID。最后 complete 收尾 |
| E03 | 在已接受且 running 的 fixture 对话点“停止当前轮” | inspect 的 stopCalls 加一、目标 runId 等于被停止轮，产品操作 type=stop；页面变“已中断”，显示后台工具可能仍运行/改动不撤销的提示。发下一条能再次运行；fixture 不证明真实工具退出 |
| E04 | 按下方五个独立分支，分别驱动存储失败、编码预算、HTTP 400、HTTP 413、原生 rejected | 每个分支都核对输入、pending、原操作编号、独立调用计数与编辑后再次发送；不能用其中一条代替其他分支 |
| E05 | 按下面真实分支分别使用 Codex、DSH | 文件字节独立读回、原生身份/配置及正文共同符合预期；每个 Harness 单独结论 |

```sh
node test/support/feature-fixture.ts complete --root "$zh_verify_root" --title '执行 A'
node test/support/feature-fixture.ts unknown-receipt --root "$zh_verify_root" --title '未知回执'
# 页面发送、核对同一发送后，再发布同一操作的原生历史证据：
node test/support/feature-fixture.ts prove --root "$zh_verify_root" --title '未知回执'
node test/support/feature-fixture.ts inspect --root "$zh_verify_root" --title '未知回执'
```

E02 另外可用 browser-faults 的 `dropNext('/api/private/workbench/conversations/' + id + '/operations')` 丢一次浏览器 HTTP 回执。若服务端状态已自动核实，pending 提示可很快消失；这是有效恢复，不要求提示必定停留。核对同一 operation ID、次数与最终用户正文是否恰好一份，才是判据。

`unknown-receipt` 只设置下一次回执，不改变已观察到的原生状态；控制命令完成后直接按 E02 发送，不需要额外 GET 或等待来同步控制命令。

E04：每个分支按 [空原生会话故障前提](conversations.md#空原生会话故障前提) 准备一个名称唯一、已就绪的空 fixture 对话，保存对话 ID、配置、初始快照和 inspect（submitCalls=0、operationIds/rejectedOperationIds 为空）。输入使用本轮独有的合成文本。按共同入口安装 [browser-faults.js](../../test/support/browser-faults.js)，HTTP 场景中的 `id` 必须来自该对话的实际 hash。所有动作仍使用页面输入框与按钮。

| 分支 | 驱动 | 拒绝后的判据 |
| --- | --- | --- |
| E04-storage | `zhVerify.denyDraftStorage()`，输入并发送；观察后 `zhVerify.restore()` | 输入完整、可编辑；提示无法保留发送编号/尚未发送；submitCalls=0，产品无 message operation，不出现 pending 发送。恢复存储后可发送 |
| E04-budget | 输入 11,000 个 U+0001 字符并发送（可用浏览器工具填入 `'\u0001'.repeat(11000)`） | 编码预算提示“本次尚未发送”；输入仍为11,000字符；submitCalls=0、产品无 message operation、无 pending。这是客户端拦截，不是 HTTP413 |
| E04-400 | `zhVerify.rejectNextRequest('/api/private/workbench/conversations/' + id + '/operations', 400)`，再输入短文本并发送 | 浏览器实际收到服务端 JSON400；journal 保存原发送 ID，产品没有该 operation、submitCalls=0、原生历史为空；输入完整、可编辑，pending 已清除，未留下“核对同一发送” |
| E04-413 | 同上，将400改为413，仍输入短文本并发送 | 实际收到服务端 JSON413，其余判据同400。工具在页面预算检查之后给请求增加70KiB字段，不能用预算提示代替收到HTTP413 |
| E04-rejected | 下列 CLI 装载 `reject-next`，命令返回后直接输入短文本并发送 | 产品操作最终 rejected（首个HTTP202可先 queued），inspect submitCalls=1、rejectedOperationIds 只有原ID、operationIds为空、历史为空、原生状态仍idle；输入和 pending 原ID保留，出现“继续编辑”。再点一次“发送消息”只核对同ID，submitCalls仍1。随后点“继续编辑”，pending清除，输入完整且可编辑 |

```sh
node test/support/feature-fixture.ts reject-next --root "$zh_verify_root" --title '本轮唯一拒绝对话名'
node test/support/feature-fixture.ts inspect --root "$zh_verify_root" --title '本轮唯一拒绝对话名'
```

`reject-next` 和 `unknown-receipt` 都只装载下一次回执，后装载者替换前者；不改变 inspect 的 revision/state，不触发状态失效。rejected 消费一次提交尝试但不接收消息、不产生 run/用户历史；`submitCalls` 包含拒绝尝试，`operationIds` 只列已接收的输入，拒绝编号另列在 `rejectedOperationIds`。

每个分支在保存拒绝证据后，改成新的短合成文本并发送；确认 accepted、pending清除、用户正文恰一份且是新文本、同原生绑定与配置。HTTP拒绝后的新ID应不同于journal里的失败ID；原生拒绝后的新ID应不同于rejected原ID。最终 storage/budget/400/413 的 submitCalls=1、operationIds只有新ID；rejected 的 submitCalls=2、operationIds只有新ID、rejectedOperationIds仍只有旧ID。最后用 complete 收尾并恢复故障工具。

只读本对话的草稿可在页面执行 `JSON.parse(sessionStorage.getItem('zhongshu:draft:v1:' + id) || 'null')`，核对 text/pending；不要导出全部存储。HTTP故障的 `zhVerify.status().journal` 应有匹配路径、POST、400/413和原ID，故障只消费一次。未知字段/超限字段仅改变出站请求，真实Fastify/Workbench响应正文不被替换。不能把手写响应或底层测试通过当成这些浏览器分支通过。此方法覆盖应用的JSON错误契约，非JSON代理错误和真实Harness拒绝需另建现场。

真实分支 E05：

1. 按共同入口先核对整个 Host 的读取边界，分别保留 shell 与原生文件工具的禁止/允许读写结果，再准备两个独立合成工作区。各写 `notes.md`，含执行者本轮确定的三条事实；创建前确认 `result.md` 不存在。记录预期字节/事实，不让模型生成预期。
2. 第一轮消息要求读取 notes、把事实写入 result，并只在首轮消息中给一个随机标记。终态后用工作区外的可信读取核对文件三条事实。不能采信“已写入”的自然语言。
3. 第二轮只问“上一轮我给的标记是什么”，不再次提供标记、不让首轮写入文件。核对正文与首轮保存的预期一致，且原生身份/模型/权限未变。
4. 为停止场景把 [workspace-gate.mjs](../../test/support/workspace-gate.mjs) 复制进本次合成目录，给 8–40 位小写字母数字标记。页面要求真实运行 `node workspace-gate.mjs <标记>`，等待 `gate-<标记>.started.json`，从可信端核对 PID/目录和进程存活，再点停止。
5. 等原生本轮 terminal/interrupted、页面中断提示；同时独立检查工具是否仍存活，单独记录。退出工具可在本次目录创建 `gate-<标记>.release`，等待 finished 文件与 PID 退出；脚本最多 90 秒自终止，`outcome: timeout` 不算释放成功。不要把清理动作当作原生 stop 的效果。

真实后台通知产生后继轮后，继续发送需要核实“上一条用户消息对应轮”的终态与当前空闲，不能只比较最新 runId。此反例的精确历史/竞争分支由定向回归提供；未实际触发真实后台通知时不宣称该原生分支通过。

### E06 / E07 排队与提前发送

1. 两端分别新建一个对话。fixture 发任意带标记的开场消息。真实 Host 按 E05 安排工作区 gate，在可信端核对工具已启动。逐条加入带唯一标记的 A、B、C，至少一条用 ⌘/Ctrl + Enter。刷新后队列应为 A、B、C。编辑 A，删除 C，再加入 D。检查未派发文字仍在队列，原生历史此时只有开场输入。
2. 在当前轮仍活动时，点击 B 所在行的提前发送按钮，核对其余行仍按 A、D 排列。真实 Host 可在 gate 尚未释放时接收 B。先核对接收回执或 DSH `next-step` 中的请求编号，再 release gate。待 B 出现在原生历史，核对它只出现一次，且与开场消息属于同一轮。让本轮正常结束，再逐轮核对编辑后的 A 和 D 各自开启一轮，原 A 和 C 的标记未进入历史。fixture 使用 `complete`，真实 Host 对照原生历史及配置。另建一个队列，点停止，核对保留与暂停，再点“继续派发”核对新轮。
3. 分别新建只有一个队列项的对话，浏览器拦截该对话的下一次 `POST /api/private/workbench/conversations/<id>/queue`，让按钮点击产生请求并暂存，核对它是该队列项的 `send`。在独立端结束原轮。为避免队首先被自动派发，先在第二个已登录页面点停止，使队列暂停，等待原生终态后才放行暂存的请求。Codex 应保留条目，原生历史没有该输入。DSH 应出现新轮和唯一输入，界面显示“提前发送的消息已送达后续轮”。保留点击时目标轮和实际历史轮的对应证据。正常结束与自动派发竞争由定向测试另测。
4. fixture 中让原轮保持运行，排入一条消息后装载 `unknown-receipt`，点该条目的提前发送。核对队列显示“接收结果待核实”。刷新并点“查询原生结果”两次，原生 inspect 的提交计数不得增加。执行 `prove` 后核对用户条目恰好一次且属于正确轮。真实 Host 若只能丢弃浏览器 HTTP 响应，单独记录为浏览器重试证据，原生回执丢失仍需通过隔离的原生连接故障验证。

### E08–E10 提问与审批

只能用真实 Host 驱动；fixture 不产生原生请求。新建对话后在页面发送合成指令：

| 场景 | 驱动 | 判据和独立观察 |
| --- | --- | --- |
| E08 DSH 提问 | DSH、任意权限（至少覆盖完全访问）。发送“用 ask_user_question 问我一次，id 为 X，选项 A、B；收到后只回复选择”。另一个已登录的隔离浏览器上下文打开同一对话 | 页头与侧栏为“等待处理”，两端都出现“Agent 在问你”卡片。在一端选择并提交：两端都变为“已回答「…」”，原生工具输出的 answers 与提交一致（单选时自己填写的文字以 `selected: []` 加 `custom` 送出）。另起一题后重启应用并刷新页面，卡片仍在、可回答 |
| E09 Codex 审批 | Codex、工作区读写。要求运行联网命令，被沙箱拦下后请求更高权限 | 卡片标题为“Agent 请求运行命令”，显示原生理由、命令与目录；按钮只有原生 `availableDecisions` 中的普通决定。允许后原生历史出现提权重跑；同一指令在完全访问的对话中不产生卡片 |
| E09 DSH 审批 | DSH、工作区读写，同样的联网指令 | 卡片只有“允许运行 / 拒绝”，理由来自原生中文说明，命令从会话记录按调用编号找回。拒绝后 Agent 报告提权被拒 |
| E10 回执与失效 | 自动化覆盖，见下方回归命令；真实 Host 只能观察“正在提交 → 已回答” | 未知回执查询不增加原生回答次数；原生仍在等待时卡片重新可选，原生停止或结束本轮后显示已失效 |

### E11–E13 Plan 模式

只能用真实 Host 驱动。为避免执行时真的改文件，可用只读权限；执行阶段的写入会变成审批，可以拒绝收尾。

| 场景 | 驱动 | 判据和独立观察 |
| --- | --- | --- |
| E11 开关 | 两端各一段对话，点工具栏的 Plan；发一条消息后在运行中再点 | 开着时说明条出现、页面刷新后仍开着、另一个浏览器上下文看到相同状态；运行中开关为灰；服务端对运行中的切换返回 `plan_change_while_running` |
| E12 Codex | 打开 Plan，发“先用 request_user_input 问我计划要几步，再给出计划，不要改文件” | 提问卡片的选项与原生一致（含“(Recommended)”）；回答后出现带“计划”标题的块和“计划已就绪”。点“按计划执行”：Plan 关闭，对话出现“按上面的计划开始执行。”，原生下一轮为默认模式。点“继续规划”只收起卡片 |
| E13 DSH | 打开 Plan，发“规划后提交审核，批准前不要改文件” | 原生 Plan 为开启；审核卡片显示原生计划正文。“继续规划”附意见后 Agent 交回修改后的计划；“批准并执行”后原生 Plan 关闭、Agent 在同一轮继续，开关随之关闭 |

## Gotchas

- **DSH 0.2.2 起，`session/follow` 默认只观察、不唤醒 Agent。** 中书的主会话跟随带 `activate: true`（0.2.1 会忽略这个字段），否则 Host 重启后被打断的轮次不会结束、排队输入不处理、停止失败。子 Agent 的跟随保持只观察。验证方法：运行中重启 DSH Host，对话应结束为已中断，下一条消息正常执行。

- `accepted` 是原生接收，操作记录不会为了表示工作结束而改成 completed；终态来自对话 state/原生历史。
- 每个对话可保留 20 条排队消息，图片与引用沿用普通消息的归属和资源检查。未派发条目可编辑或删除。错过 Codex 目标轮、停止或失败后保留队列并暂停，用户可选择“继续派发”。DSH 的“尽快发送”允许后续轮接收，实际轮次以原生用户条目为准。
- 带显式技能的 Codex 消息保留在队列，等下一轮调用。两端技能随队列派发的原生证据见[技能引用 U12](conversation-usability.md#u12-技能引用)。
- POST 202 可能先返回 `queued/dispatching` 且 runId 为空；保存操作 ID，随后等待回执核实。不能要求首个 HTTP 正文立即成为 unknown/accepted 或包含目标原生 runId。
- 停止按钮针对当前 runId；“已中断”不承诺撤销文件副作用、清空待处理输入或终止全部后台进程。
- 最终文件只有一份不能证明没有重复执行。E02 必须检查调用数和操作身份。
- 一般输入上限为 16,000 字符，服务端另有 UTF-8 与请求体上限；中文和特殊字符的编码长度可先触发拒绝。不能靠截断输入掩盖失败。
- fixture 的正文、权限和停止都是确定性边界数据，不证明真实模型、工具权限或原生通知行为。
- Codex 只在 Plan 模式下发出结构化提问；默认模式用文字提问，本切片不接 Codex 提问。审批策略在新建时随权限固定：完全访问为从不询问，其余为需要时询问；本切片之前创建的 Codex 对话仍从不询问。
- Codex 每个审批给出的决定不同（联网提权常只有“允许”和“拒绝并停止本轮”）；“以后都允许”这类规则型决定不提供。DSH 审批只有允许一次和拒绝，子 Agent 不会向用户提问或要审批。
- DSH 内置预设的提问没有截止时间。限时提问超时后，原生会转为可补答；中书显示为已失效，不接补答。
- 请求内容只在应用内存中；已回答或已失效的卡片保留约 10 分钟，应用重启后消失。回答在送达后只保留摘要。
- “没能确认上一次回答被采用”出现在回答回执未知、而原生仍在等待时；再选一次不会让原生执行两次，因为原生每个请求只采用一次回答。
- 开发用容器可能没有 curl 或外网；命令失败不影响审批是否生效的判断，判据看原生历史中是否出现提权重跑或被拒。
- Plan 只是让 Agent 先规划，两端都不限制工具；需要限制时靠权限与审批。
- DSH 在已经跑过的会话里切换 Plan，会在原生“下一步”队列留一条“已切换 Plan”的提示，它随下一条消息一起被带走，不算待处理输入，不能挡住发送。E13 要在对话跑过至少一轮之后再打开 Plan，才能覆盖这个分支。
- Codex 的模式是线程设置，中书每轮都明确发送 Plan 或默认，并沿用对话的模型和思考深度；Codex 的开关保存在中书。DSH 的开关以原生状态为准，原生在批准计划后自行退出 Plan。
- “计划已就绪”由中书根据原生计划条目与本轮终态得出：之后有新消息、排队或 Plan 已关闭都不显示；“继续规划”只在本页收起，不改变状态。
- Codex 官方客户端的“清空上下文后执行”（另开线程）不提供。

## Implementation and regression

- 页面门禁、草稿、发送/停止：[workbench.tsx](../../src/web/workbench.tsx)；请求与 pending 草稿：[workbench-client.ts](../../src/web/workbench-client.ts)。
- 发送、停止与 reconcile：[execution.ts](../../src/server/workbench/execution.ts)；持久队列、claim 与终态核对：[queue.ts](../../src/server/workbench/queue.ts)、[workbench-store.ts](../../src/server/workbench-store.ts)。
- 原生派发/停止：[Codex](../../src/harness/codex/index.ts)、[DSH](../../src/harness/dsh/index.ts)。
- E04 永久故障入口与真实HTTP/CLI回归：[feature-fixture.ts](../../test/support/feature-fixture.ts)、[browser-faults.js](../../test/support/browser-faults.js)、[feature-fixture.test.ts](../../test/feature-fixture.test.ts)。运行 `node --test test/feature-fixture.test.ts`；覆盖两个替身的单次拒绝/同ID不重派/新ID恢复、装载不失效、真实400/413及故障只消费一次；Node中的最小页面表面不证明DOM行为，仍须跑上述真实浏览器分支。
- `node --test test/workbench.test.ts test/workbench-store.test.ts test/workbench-http.test.ts test/codex.test.ts test/dsh.test.ts`：覆盖 ACK 门禁、目标轮终态、目标变化、未知回执、重复提交、当前停止目标与派发中崩溃。实际浏览器判据仍是 E01–E04。
- Plan 模式：开关与就绪提示在 [plan.tsx](../../src/web/plan.tsx) 与 [展示组件](../../src/web/patterns/plan.tsx)，服务端在 Workbench 的 `setPlan` / `planReady`；`node --test test/plan.test.ts test/codex.test.ts test/dsh.test.ts` 覆盖开关、运行中拒绝、每轮模式、就绪判定、计划审核与 Codex 提问格式；真实判据是 E11–E13。
- 提问与审批：原生请求的接收与回答在 [Codex 请求](../../src/harness/codex/requests.ts)、[DSH 请求](../../src/harness/dsh/requests.ts) 及各自 adapter；回答操作在 [request-store.ts](../../src/server/request-store.ts) 与 Workbench；卡片在 [requests.tsx](../../src/web/requests.tsx) 与 [展示组件](../../src/web/patterns/requests.tsx)，Storybook「工作台 / 提问与审批」展示各状态。`node --test test/requests.test.ts test/codex.test.ts test/dsh.test.ts test/workbench-http.test.ts` 覆盖送达确认、断线重发、未知回执不重发、失效、重启恢复、多端重复提交与认证/CSRF；真实判据仍是 E08–E09。
