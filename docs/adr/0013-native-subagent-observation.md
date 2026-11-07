---
status: accepted
---

# 中书观察并可停止原生子 Agent，但不派生、不指挥它们

## 背景与依据

2026-11-06，用户计划把中书长期部署在远程服务器上，作为常驻的主 Agent 工作台。Codex 与 DSH 都会在一段对话中派生子 Agent，DSH 还有实验性的团队。中书此前看不到这些子 Agent：Codex adapter 丢弃不属于所观察对话的事件，DSH adapter 只跟随主会话。

在固定兼容版本上对照源码核实（未在真实 Host 运行）：

- 两端都把子 Agent 做成带父子关系的独立原生会话。客户端可以列出、读取和实时观察它们，也可以停止单个子 Agent。
- 两端都没有让客户端派生、分配或预先指定子 Agent 的接口，是否派生由模型决定。
- Codex 多数模型采用 v2 多 Agent 机制，其子 Agent 拒绝客户端的直接输入。DSH 只有在主 Agent 在线时才接受客户端向子 Agent 发消息。
- 停止主 Agent 当前轮时，两端的子 Agent 都会继续运行；DSH 的子 Agent 完成后还会唤醒主 Agent。
- Codex 子 Agent 继承主 Agent 当前轮的审批策略。它的审批请求只发给订阅了该子 Agent 的连接，无人应答时一直等待。DSH 子 Agent 的审批一律自动拒绝。
- Codex 归档或删除主 Agent 会级联到整棵子树；DSH 归档主 Agent 会停止其后代。

依据：[Codex App Server 协议](https://github.com/openai/codex/tree/rust-v0.166.0-alpha.5.1/codex-rs/app-server-protocol/src/protocol/v2)、[Codex 子 Agent 输入限制](https://github.com/openai/codex/blob/rust-v0.166.0-alpha.5.1/codex-rs/app-server/src/request_processors/thread_input.rs)、[Codex 子 Agent 结果投递](https://github.com/openai/codex/blob/rust-v0.166.0-alpha.5.1/codex-rs/core/src/agent/control/completion.rs)、[DSH 子 Agent 远程接口](https://github.com/deepseek-ai/deepseek-harness/blob/504a01a9578abc2c6f1fb896b1dc322c9fe24f66/packages/subagent/subagent/src/index.ts)、[DSH 会话地址与请求类型](https://github.com/deepseek-ai/deepseek-harness/blob/504a01a9578abc2c6f1fb896b1dc322c9fe24f66/packages/api/session-controller/src/types.ts)、[DSH 团队](https://github.com/deepseek-ai/deepseek-harness/blob/504a01a9578abc2c6f1fb896b1dc322c9fe24f66/packages/experimental/agent-team/README.md)。这些是协议依据，不替代目标版本的真实验证。

用户在对齐中逐项确认了下列选择，并认可了 Storybook 中的界面原型。

## 决定

- **分工。** 子 Agent 由 Harness 派生和执行，中书只负责让它们可见，并允许停止单个子 Agent。中书不派生子 Agent，不给它分配任务，也不向它发送消息。由中书在多段对话之间派活的编排层不在本决定内，需要另行决定。
- **停止的含义。** 停止对话只停止主 Agent 的当前轮，保持原生语义。子 Agent 需要单独停止。仍有子 Agent 在运行时，中书必须明确告知，并说明 DSH 可能自动继续主 Agent。
- **入口位置。** 子 Agent 和团队从所属对话进入，不进入侧栏，也不成为独立对话。入口是对话头部专门的「子 Agent」按钮，打开阅读区位置的面板，窄屏时为整页。这一轮不建立通用的对话概况容器。
- **数据归属。** 中书持久化子 Agent 索引：原生身份、所属对话、父子关系、显示信息和最后核实的状态。子 Agent 的过程记录只在需要时向原生读取，不存入中书。团队成员与共享任务同样以原生为准，只读展示。
- **状态必须如实。** 子 Agent 状态来自原生核实。连接中断或无法核实时，所有展示位置都显示待核实，不得算作运行中或已结束，也不提供停止。停止子 Agent 是带稳定编号的操作，回执未知时按 [ADR 0004](0004-recoverable-communication.md) 核对，不自动重发。
- **收取结果。** 中书不替用户向主 Agent 发送输入，也不启用 Codex 处于开发中的自动唤醒特性。子 Agent 在主 Agent 那一轮结束后才完成时，中书只提示：主 Agent 要到下一轮才会读到这些结果。
- **归属核实。** 读取或停止子 Agent 前，服务端必须核实它属于该对话的原生子树。浏览器提供的子 Agent 身份不是授权依据，沿用 [ADR 0006](0006-auth-session-data.md)。
- **观察不能改变原生行为。** 观察沿用 [ADR 0012](0012-conversation-lifecycle.md) 的执行责任与阅读需求。释放对子 Agent 的观察，不能导致原生关闭或卸载仍需继续的子 Agent。对话的归档、删除条件要计入正在运行的子 Agent。
- **审批依赖。** 对话仍以不请求审批的策略运行，子 Agent 继承这一策略。接通审批或提问时，必须同时处理子 Agent 发出的请求，否则 Codex 子 Agent 会一直等待。（2026-11-07：[ADR 0016](0016-questions-and-approvals.md) 改为审批策略跟随对话权限，替代本条第一句；处理子 Agent 请求的要求保留。）

本决定在 [ADR 0001](0001-native-harness-boundary.md) 的原生执行权之内，补充中书对子 Agent 的观察边界，不改变原生派生与执行的归属。

## 取舍与后果

| 被放弃的方案 | 原因 |
| --- | --- |
| 中书派生或分配子 Agent | 两端没有这样的接口；自行实现等于重建 Agent 编排，超出原生边界。常驻主 Agent 的跨对话派活留待另一个决定 |
| 停止对话时停止整棵子树 | 用户选择保留原生语义。代价是按下停止后，工作可能仍在继续；靠明确提示和单独停止弥补 |
| 在中书里向子 Agent 发消息 | 用户实际不这样使用；Codex v2 不支持，两端体验会不一致，失败分支也更多 |
| 子 Agent 进入侧栏树 | 侧栏会随子 Agent 数量变长，手机上更拥挤；两端原生界面也不在会话列表中显示子 Agent |
| 子 Agent 过程存入中书 | 会成倍增加存储，还要处理同步、删除和容量；代价是 Host 不可达时只能看到名单和最后状态 |
| 通用的对话概况面板 | 长期可能更整齐，但这一轮会多出一个需要设计的容器；需要时再演进 |

后果：

- 两个 adapter 都要新增子 Agent 的发现、观察、读取和停止能力。Codex 要接住带子 Agent 身份的事件，并在重连后重新找回运行中的子 Agent；DSH 要逐个跟随子会话。
- 两端差异通过能力和结果表达，包括 Codex v1/v2、DSH 外部执行的子 Agent 没有过程记录。
- 原生版本升级须复核这些接口；已知 DSH 0.2.2 调整了会话跟随和控制流。
- 范围、用户路径与验收归[原生子 Agent 工作单](../spec/native-subagents.md)。
