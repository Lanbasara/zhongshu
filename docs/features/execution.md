# 执行与停止：feature map

当前能力：发送文本、观察正文/工具活动、终态核实后在同对话继续，以及停止当前轮。发送与恢复决策见 [ADR 0004](../adr/0004-recoverable-communication.md)，原生语义见 [ADR 0001](../adr/0001-native-harness-boundary.md)。

## Sub-features

| 场景 | 要证明的行为 |
| --- | --- |
| E01 | 发送进入同一对话；接收回执不等于本轮完成 |
| E02 | 原生结果未知时核对原操作，不重复派发 |
| E03 | 停止指向当前轮，显示中断及后台工具限制；之后可接续 |
| E04 | 无法保留发送编号时不派发；明确拒绝后保留可编辑输入 |
| E05 | 两个真实 Harness 分别读写文件、同会话回忆，并核验真实停止 |

## How to get to it (user POV)

进入配置已核实的对话 →“给 Agent 的消息”→“发送消息”（视觉文字“发送 ↑”），或 ⌘/Ctrl + Enter。Enter 换行。运行/等待且有运行 ID 时显示“停止当前轮”。未知状态可见“查询原生结果”；未确认草稿可见“核对同一发送”。没有运行中追加、回答问题或审批的操作入口。

## Driving it with Harness

先完成 [共同入口](README.md) 和 C01。fixture 收到文本后保持运行，只有 CLI complete 或页面停止会到终态；这样无需靠消息长度或固定 sleep 猜测运行窗口。

| 场景 | 初始条件与动作 | 判据和独立观察 |
| --- | --- | --- |
| E01 | 建“执行 A”，输入含本轮独有标记的两行文本；先按 Enter，再发送。运行中尝试 ⌘/Ctrl + Enter；CLI complete 后输入新文本再发送 | Enter 不派发；首次发送 inspect 的 submitCalls=1、正文有两行用户输入、出现停止按钮。运行中快捷键不增加次数。complete 后出现 `FIXTURE COMPLETED <runId>`、恢复发送，再发后 submitCalls=2；两轮同原生身份、配置不变 |
| E02 | 建“未知回执”；先运行 unknown-receipt，再发送唯一文本。保存产品操作 ID、inspect 调用数；在“核对同一发送”重试两次；再运行 prove，点“查询原生结果” | 未发布证据前，操作 unknown、保留 pending 草稿，同编号重试不增加 submitCalls。发布后 accepted，草稿中的 pending 被清除；inspect 始终只调用一次，原生 operationIds 只有原 ID。最后 complete 收尾 |
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

E04：每个分支新建一个名称唯一、已就绪的空 fixture 对话，保存对话 ID、配置、初始快照和 inspect（submitCalls=0、operationIds/rejectedOperationIds 为空）。输入使用本轮独有的合成文本。按共同入口安装 [browser-faults.js](../../test/support/browser-faults.js)，HTTP 场景中的 `id` 必须来自该对话的实际 hash。所有动作仍使用页面输入框与按钮。

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

1. 按共同入口准备受限原生 Host 与两个独立合成工作区。各写 `notes.md`，含执行者本轮确定的三条事实；创建前确认 `result.md` 不存在。记录预期字节/事实，不让模型生成预期。
2. 第一轮消息要求读取 notes、把事实写入 result，并只在首轮消息中给一个随机标记。终态后用工作区外的可信读取核对文件三条事实。不能采信“已写入”的自然语言。
3. 第二轮只问“上一轮我给的标记是什么”，不再次提供标记、不让首轮写入文件。核对正文与首轮保存的预期一致，且原生身份/模型/权限未变。
4. 为停止场景把 [workspace-gate.mjs](../../test/support/workspace-gate.mjs) 复制进本次合成目录，给 8–40 位小写字母数字标记。页面要求真实运行 `node workspace-gate.mjs <标记>`，等待 `gate-<标记>.started.json`，从可信端核对 PID/目录和进程存活，再点停止。
5. 等原生本轮 terminal/interrupted、页面中断提示；同时独立检查工具是否仍存活，单独记录。退出工具可在本次目录创建 `gate-<标记>.release`，等待 finished 文件与 PID 退出；脚本最多 90 秒自终止，`outcome: timeout` 不算释放成功。不要把清理动作当作原生 stop 的效果。

真实后台通知产生后继轮后，继续发送需要核实“上一条用户消息对应轮”的终态与当前空闲，不能只比较最新 runId。此反例的精确历史/竞争分支由定向回归提供；未实际触发真实后台通知时不宣称该原生分支通过。

## Gotchas

- `accepted` 是原生接收，操作记录不会为了表示工作结束而改成 completed；终态来自对话 state/原生历史。
- POST 202 可能先返回 `queued/dispatching` 且 runId 为空；保存操作 ID，随后等待回执核实。不能要求首个 HTTP 正文立即成为 unknown/accepted 或包含目标原生 runId。
- 停止按钮针对当前 runId；“已中断”不承诺撤销文件副作用、清空待处理输入或终止全部后台进程。
- 最终文件只有一份不能证明没有重复执行。E02 必须检查调用数和操作身份。
- 一般输入上限为 16,000 字符，服务端另有 UTF-8 与请求体上限；中文和特殊字符的编码长度可先触发拒绝。不能靠截断输入掩盖失败。
- fixture 的正文、权限和停止都是确定性边界数据，不证明真实模型、工具权限或原生通知行为。

## Implementation and regression

- 页面门禁、草稿、发送/停止：[workbench.tsx](../../src/web/workbench.tsx)；请求与 pending 草稿：[workbench-client.ts](../../src/web/workbench-client.ts)。
- 持久队列、claim、终态核对与 reconcile：[workbench.ts](../../src/server/workbench.ts)、[workbench-store.ts](../../src/server/workbench-store.ts)。
- 原生派发/停止：[Codex](../../src/harness/codex/index.ts)、[DSH](../../src/harness/dsh/index.ts)。
- E04 永久故障入口与真实HTTP/CLI回归：[feature-fixture.ts](../../test/support/feature-fixture.ts)、[browser-faults.js](../../test/support/browser-faults.js)、[feature-fixture.test.ts](../../test/feature-fixture.test.ts)。运行 `node --test test/feature-fixture.test.ts`；覆盖两个替身的单次拒绝/同ID不重派/新ID恢复、装载不失效、真实400/413及故障只消费一次；Node中的最小页面表面不证明DOM行为，仍须跑上述真实浏览器分支。
- `node --test test/workbench.test.ts test/workbench-store.test.ts test/workbench-http.test.ts test/codex.test.ts test/dsh.test.ts`：覆盖 ACK 门禁、目标轮终态、目标变化、未知回执、重复提交、当前停止目标与派发中崩溃。实际浏览器判据仍是 E01–E04。
