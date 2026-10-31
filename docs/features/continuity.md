# 接续与阅读：feature map

范围：恢复同一对话、保留未确认输入、读取完整历史。持久化与恢复语义归 [ADR 0003](../adr/0003-local-persistence.md) 与 [ADR 0004](../adr/0004-recoverable-communication.md)。

## Sub-features

- 关页再回来：运行中关闭页面，重开后恢复输出和真实状态。
- 中书中断：只终止中书进程，重启后恢复原生身份、历史和结果。
- 原生断连/重启：Host 单独中断后的未知/受阻与恢复。
- 草稿与未知回执：切换对话、刷新后保留当前端草稿；未知发送按编号核对。
- 历史阅读：查看更早内容、回到最新、旧响应不覆盖新页面。
- 多端阅读：另一独立登录端可读取同一对话，不共享未发送草稿。

## How to get to it (user POV)

1. 侧栏选择既有对话；带对话 hash 的地址也应落回同一身份。
2. 恢复网络后观察自动重连；也可点“重新连接”主动刷新快照和目录。
3. 历史顶部点“查看更早的内容”；旧窗口中点“回到最新内容”。
4. 运行中关闭自己创建的页面，重新打开同一对话。

## Driving it with Harness

先按 [features/README](README.md) 的 Launch/Doctor 准备独立现场，再按 [execution](execution.md) 建立有确定内容和稳定条目身份的历史。

1. 启动一个有独立启动信号的受控工具，确认原生工作已经开始。
2. 关闭本次创建的浏览器页面；独立确认原生 Host 和工具继续运行。
3. 重开同一对话，核对正文、状态和历史；另一独立登录端也在不共享草稿的前提下读取同一对话。
4. 中书中断场景记录产品/原生身份，只终止本次中书进程，保持原生 Host 存活；用相同数据目录重启，核对无替代对话、无盲目重派。
5. 原生断连/重启场景单独操作本次拥有的 Host，观察未知/受阻，再按原生持久状态核对恢复。
6. 长历史使用明确标记的原生替身准备，但仍由真实应用、HTTP 和页面读取。

## Gotchas

- **中书重启不等于原生 Host 崩溃。** 不能用 Host 从未停止的运行证明 Host 崩溃恢复。
- **关闭页面不等于取消任务。** 原生工作独立于浏览器和观察连接。
- **温和退出与突然终止是不同证据。** 分别记录。
- **草稿只在当前标签页。** 不做跨设备草稿同步；不要承诺另一端能看到未发送输入。
- **旧响应不能覆盖新状态。** 切换对话、快速事件和慢快照并发时要防止旧响应回写。
- **历史缺口要明确暴露。** 超出恢复窗口时保留待核实状态，不把缺口伪装成完整历史。
- **固定 sleep 不是通过条件。** 等待具体状态或内容；超时保留最后事实。

## Implementation and regression

- HTTP 校验、公开数据与有界更新流：[workbench-http.ts](../../src/server/workbench-http.ts)
- 共享契约：[shared/workbench.ts](../../src/shared/workbench.ts)
- 页面恢复、草稿、阅读和发送反馈：[workbench.tsx](../../src/web/workbench.tsx)、[workbench-client.ts](../../src/web/workbench-client.ts)
- 持久化与迁移：[database.ts](../../src/server/database.ts)、[migrations.ts](../../src/server/migrations.ts)
- 回归：[workbench-http.test.ts](../../test/workbench-http.test.ts)、[workbench-store.test.ts](../../test/workbench-store.test.ts)、[http.test.ts](../../test/http.test.ts)
