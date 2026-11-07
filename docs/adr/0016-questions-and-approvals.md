---
status: accepted
---

# Agent 的提问始终送到中书，审批按对话权限决定是否询问

## 背景与依据

2026-11-07，用户指出中书没有处理 Agent 向用户提问的任何场景，审批只是提问的一种。用户平时多用完全访问，但不希望 Agent 因此无法提问；选完全访问时，审批不应再询问，视为全部授权。用户同时确认两端都提供 Plan 模式。

当前代码：

- Codex 对话固定以“从不审批”运行，Codex 发来的任何交互请求都被直接拒绝。
- DSH 以不参与交互的身份连接。提问时对话显示为等待，但无法回答；越界的审批被自动拒绝。
- DSH 的标准和 PTC 预设默认带提问工具，所以日常使用会卡住。

在固定兼容版本上对照源码核实（未在真实 Host 运行）：

- Codex 发给客户端的交互请求有：命令、文件修改、追加权限三类审批；结构化提问；MCP 信息请求。
  - 结构化提问只在 Plan 模式下可用（默认模式要打开开发中的开关），并且只允许主 Agent 使用。
  - 是否出现审批，由对话的审批策略决定。
  - Plan 模式按轮传入协作模式。
- DSH 的权限预设把沙箱和审批绑在一起：工作区读写会询问，完全访问从不询问。
  - 提问工具只允许主 Agent 使用；子 Agent 的问题写进它交回的结果。
  - 中书必须以应答身份连接，才能收到并回答提问和审批。
  - Plan 模式用 `/plan` 进入，退出时的计划审核本身就是一次提问。

依据：[Codex 交互请求类型](https://github.com/openai/codex/blob/rust-v0.166.0-alpha.5.1/codex-rs/app-server-protocol/src/protocol/common.rs)、[Codex 结构化提问](https://github.com/openai/codex/blob/rust-v0.166.0-alpha.5.1/codex-rs/core/src/tools/handlers/request_user_input.rs)、[Codex 协作模式](https://github.com/openai/codex/blob/rust-v0.166.0-alpha.5.1/codex-rs/app-server-protocol/src/protocol/v2/collaboration_mode.rs)、[DSH 提问](https://github.com/deepseek-ai/deepseek-harness/blob/504a01a9578abc2c6f1fb896b1dc322c9fe24f66/packages/interaction/user-questions/README.md)、[DSH 权限预设](https://github.com/deepseek-ai/deepseek-harness/blob/504a01a9578abc2c6f1fb896b1dc322c9fe24f66/packages/interaction/permission-presets/README.md)、[DSH 连接身份](https://github.com/deepseek-ai/deepseek-harness/blob/504a01a9578abc2c6f1fb896b1dc322c9fe24f66/packages/client/connection/README.md)、[DSH Plan 模式](https://github.com/deepseek-ai/deepseek-harness/blob/504a01a9578abc2c6f1fb896b1dc322c9fe24f66/packages/plan/plan-mode/README.md)。这些是协议依据，不替代目标版本的真实验证。

## 决定

- **提问。** 不论对话是什么权限，两端主 Agent 的结构化提问都送到中书。用户可以在任一设备上回答，回答一次即有效，其他设备随之显示已回答（即 [CONTEXT](../../CONTEXT.md) 中的待处理请求）。
  - Codex 默认模式沿用原生行为，用文字提问，不打开开发中的开关。
  - MCP 信息请求按原生提供的形式呈现；中书无法呈现的类型，明确拒绝并说明原因，不静默挂起。
- **审批。**
  - 完全访问：不询问，全部允许。Codex 用“从不审批”，DSH 用原生的完全访问预设。
  - 工作区读写与只读：审批送到中书，由用户决定，选项按原生提供的来。
  - 子 Agent 发出的审批也送到中书，标明来自哪个子 Agent（[ADR 0013](0013-native-subagent-observation.md)）。
- **固定配置。** 审批策略跟随权限，在新建对话时确定，属于对话的固定配置（[ADR 0001](0001-native-harness-boundary.md)）。已有对话保持创建时的策略，例如旧的 Codex 对话仍然从不审批。
- **Plan 模式。** 两端都提供，在输入区开关，不属于固定配置。Codex 按轮传入协作模式；DSH 用原生命令进入和退出，计划审核以提问的形式呈现。
- **需要处理。** 有提问或审批在等待的对话计入“需要处理”，参与未读和提醒；离开页面时的推送按 [ADR 0018](0018-push-notifications.md)。
- **操作与恢复。**
  - 回答和审批是带稳定编号的操作，回执未知时去核对，不自动重发（[ADR 0004](0004-recoverable-communication.md)）。
  - 每个请求绑定原生会话和有效代次。原生已结束或代次已变化的请求不可再提交，并明确显示为失效。

本决定替代 [ADR 0013](0013-native-subagent-observation.md) 中“对话仍以不请求审批的策略运行”一句。

## 取舍与后果

| 被放弃的方案 | 原因 |
| --- | --- |
| 维持一律不询问 | Agent 的提问被拒或卡住；工作区权限下越界操作直接失败 |
| 完全访问时也询问审批 | 用户明确选择：完全访问即全部授权 |
| 为 Codex 默认模式打开开发中的结构化提问 | 与官方 App 的行为不一致，接口也可能变化 |
| 允许修改已有对话的审批策略 | 违反对话配置固定的约定；需要时新建对话 |

后果：

- 两个 adapter 都要新增交互请求的接收、保存和应答。DSH 连接改为应答身份后，事件的接收方式会随之变化。
- 要处理的情况包括：连接中断时仍未回答的请求、多端同时回答、子 Agent 的请求、DSH 定时提问超时后 Agent 已继续而回答迟到。
- 工作区权限下，Agent 会因审批停下来等待；完全访问的对话行为不变。
