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
| E04 | 安装故障工具，执行 `zhVerify.denyDraftStorage()`；输入新文本并发送。恢复工具后重试 | 输入保留并显示浏览器无法保存草稿/发送编号，inspect submitCalls 不变；恢复后可发送。页面超出编码预算也必须在派发前保留输入。服务端 400/413 和原生 rejected 分支用下方定向回归核对，不能由存储失败外推 |
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

真实分支 E05：

1. 按共同入口准备受限原生 Host 与两个独立合成工作区。各写 `notes.md`，含执行者本轮确定的三条事实；创建前确认 `result.md` 不存在。记录预期字节/事实，不让模型生成预期。
2. 第一轮消息要求读取 notes、把事实写入 result，并只在首轮消息中给一个随机标记。终态后用工作区外的可信读取核对文件三条事实。不能采信“已写入”的自然语言。
3. 第二轮只问“上一轮我给的标记是什么”，不再次提供标记、不让首轮写入文件。核对正文与首轮保存的预期一致，且原生身份/模型/权限未变。
4. 为停止场景把 [workspace-gate.mjs](../../test/support/workspace-gate.mjs) 复制进本次合成目录，给 8–40 位小写字母数字标记。页面要求真实运行 `node workspace-gate.mjs <标记>`，等待 `gate-<标记>.started.json`，从可信端核对 PID/目录和进程存活，再点停止。
5. 等原生本轮 terminal/interrupted、页面中断提示；同时独立检查工具是否仍存活，单独记录。退出工具可在本次目录创建 `gate-<标记>.release`，等待 finished 文件与 PID 退出；脚本最多 90 秒自终止，`outcome: timeout` 不算释放成功。不要把清理动作当作原生 stop 的效果。

真实后台通知产生后继轮后，继续发送需要核实“上一条用户消息对应轮”的终态与当前空闲，不能只比较最新 runId。此反例的精确历史/竞争分支由定向回归提供；未实际触发真实后台通知时不宣称该原生分支通过。

## Gotchas

- `accepted` 是原生接收，操作记录不会为了表示工作结束而改成 completed；终态来自对话 state/原生历史。
- 停止按钮针对当前 runId；“已中断”不承诺撤销文件副作用、清空待处理输入或终止全部后台进程。
- 最终文件只有一份不能证明没有重复执行。E02 必须检查调用数和操作身份。
- 一般输入上限为 16,000 字符，服务端另有 UTF-8 与请求体上限；中文和特殊字符的编码长度可先触发拒绝。不能靠截断输入掩盖失败。
- fixture 的正文、权限和停止都是确定性边界数据，不证明真实模型、工具权限或原生通知行为。

## Implementation and regression

- 页面门禁、草稿、发送/停止：[workbench.tsx](../../src/web/workbench.tsx)；请求与 pending 草稿：[workbench-client.ts](../../src/web/workbench-client.ts)。
- 持久队列、claim、终态核对与 reconcile：[workbench.ts](../../src/server/workbench.ts)、[workbench-store.ts](../../src/server/workbench-store.ts)。
- 原生派发/停止：[Codex](../../src/harness/codex/index.ts)、[DSH](../../src/harness/dsh/index.ts)。
- `node --test test/workbench.test.ts test/workbench-store.test.ts test/workbench-http.test.ts test/codex.test.ts test/dsh.test.ts`：覆盖 ACK 门禁、目标轮终态、目标变化、未知回执、重复提交、当前停止目标与派发中崩溃。实际浏览器判据仍是 E01–E04。
