# 执行与停止：feature map

范围：发送文本、观察真实工作、接续下一轮和停止当前轮。发送/停止契约归 [ADR 0001](../adr/0001-native-harness-boundary.md) 与 [ADR 0004](../adr/0004-recoverable-communication.md)。

## Sub-features

- 发送消息：文本进入当前对话，取得稳定操作编号。
- 真实工作：模型读取工作区文件并把结果写回。
- 同会话接续：在原对话追问，复用原生上下文和固定配置。
- 接收与完成分开：原生已接收不提前开放下一轮。
- 回执未知：按同一编号核对，不重复派发。
- 停止当前轮：目标当前运行编号，等待原生终态。
- 后台通知轮次：原生后台任务完成后可能产生后继轮，界面不能永久卡住。

## How to get to it (user POV)

1. 登录后从侧栏进入一段配置已核实的对话。
2. 在“给 Agent 的消息”输入文本，点“发送消息”或按 ⌘/Ctrl + Enter；Enter 换行。
3. 运行时入口变为“停止当前轮”；回执未知时使用“查询原生结果”或“核对同一发送”。
4. 完成后继续追问；需要中止时点停止。

## Driving it with Harness

先按 [features/README](README.md) 的 Launch/Doctor 准备独立现场，再准备真实原生 Host 和合成工作区。

1. 在两个内容相同、目录独立的合成工作区各放一份 `notes.md`，写入三条本轮自定事实。
2. 分别创建 Codex 与 DSH 对话，选择实际可用的模型和权限。
3. 发送“读 notes.md，把三条事实写入 result.md”，观察正文、工具活动和终态。
4. 在同一对话追加一个只在首轮消息里出现过的随机标记，确认原生上下文复用。
5. 停止场景准备一个有独立启动信号、释放条件和外部清理手段的短小受控工具；先确认确实处于运行中，再点停止。
6. 回执未知场景精确地让原生已收到、但回执未被确认，再点核对；确认没有第二次派发。

## Gotchas

- **HTTP 接收回执不是完成证据。** 只有原生轮次终态被核实后，才能开放下一轮。
- **模型说“已写入”“已停止”不是独立证据。** 读回工作区文件、核对原生状态。
- **“已中断”不代表所有后台工具已退出。** 两个 Harness 都可能保留已经启动的后台工具；界面必须提示这一限制。
- **最终文件只有一份，不能证明没有重复执行。** 回执未知时必须核对操作编号和原生消息身份。
- **DSH 权限设置产生的被动上下文不是阻塞消息。** 但原生真实待处理输入仍须阻塞，不能为了放行而忽略。
- **后台通知会产生后继轮。** 不能只比较“最新轮次”和“最后用户轮次”；要分别核实上一条消息的终态和当前空闲。
- 空历史不表示读取失败；Codex 空会话也可能有有效原生绑定。

## Implementation and regression

- 派发、回执、恢复与观察生命周期：[workbench.ts](../../src/server/workbench.ts)
- 操作记录、历史投影与持久水位：[workbench-store.ts](../../src/server/workbench-store.ts)
- Codex 适配：[codex/index.ts](../../src/harness/codex/index.ts)
- DSH 适配：[dsh/index.ts](../../src/harness/dsh/index.ts)
- 共同语义：[harness/types.ts](../../src/harness/types.ts)
- 回归：[workbench.test.ts](../../test/workbench.test.ts)、[codex.test.ts](../../test/codex.test.ts)、[dsh.test.ts](../../test/dsh.test.ts)
