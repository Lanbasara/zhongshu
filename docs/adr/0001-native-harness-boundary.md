---
status: accepted
---

# 工作台接入原生 Harness，保留原生执行权

中书采用单用户、可自托管的 PWA，电脑和 Android 访问同一应用服务。首版接入 Codex App Server 与 DSH Web Host：中书拥有工作台交互，Harness 拥有 Agent 执行、工具、上下文和原生子 Agent。这使中书能改善跨设备工作体验，同时保留原生能力；代价是必须接纳并验证两个 Harness 的能力差异。

## 责任与生命周期

| 责任 | 归属与接口边界 |
| --- | --- |
| 身份与访问 | 中书统一认证、授权；浏览器通过中书使用私有能力 |
| 工作区 | 中书登记允许区域内的目录，以稳定身份关联对话和文件 |
| 对话 | 中书保存配置、原生绑定与用户操作；原生执行事实经接入模块核实 |
| Harness 接入 | 各自负责能力发现、创建/恢复、动作、历史、问题和审批；保留原生身份、版本与连接代次 |
| 阅读与编辑 | 中书提供成果入口与条件保存；工作区文件保存实际内容 |
| 浏览器 | 维护当前端未发送输入、未保存编辑、焦点和阅读位置；已提交状态由服务端恢复 |

这些是职责边界，按实际切片长出模块。中书应用先保持一个服务，原生 Harness 是独立执行单元。浏览器连接不拥有任务生命周期；页面关闭不能取消任务。进程监管、重启恢复能力和文件访问通道由[接入实验](../plans/integration-probes.md)确定。

原生服务不直接暴露到公网。Agent 执行身份仅获得其 HOME、原生数据和允许的工作区，不获得中书认证存储、部署凭据或宿主管理能力；目录名称本身不构成权限隔离。

原生进程退出、会话记录为中断与工具进程实际退出是不同事实。运行托管须分别监督与确认清理，不能仅凭原生终态宣称所有文件副作用已停止，也不能把重新读到历史当作无损续跑。

## 接入模块与两个 adapter

接入模块向应用提供中书需要的会话、操作、历史和能力契约；内部由 Codex、DSH 两个 adapter 解释原生协议。应用统一维护工作台状态与浏览器恢复，adapter 负责握手、原生配置、身份映射、订阅、原生恢复与错误解释。页面不依赖原生请求字段；两个 adapter 也不各自复制一套工作台业务逻辑。

统一的是可依赖的语义，真实差异通过能力及结果表达。Codex 的 `turn/steer` 要求匹配活动轮次；DSH 的原生输入策略存在 next-step/next-turn 差别。DSH rc.4 的 API Peer 在拥有它的 WebSocket 关闭后失效，`follow` 重连从新快照开始，`cancel` 保留待处理 inbox。连接身份、会话身份和运行身份因此不能压成一个 ID；停止也不能统一承诺清空所有待办。[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[DSH 连接](https://github.com/deepseek-ai/deepseek-harness/blob/504a01a9578abc2c6f1fb896b1dc322c9fe24f66/packages/client/connection/README.md#browser-authentication-and-request-trust)、[DSH 请求类型](https://github.com/deepseek-ai/deepseek-harness/blob/504a01a9578abc2c6f1fb896b1dc322c9fe24f66/packages/api/session-controller/src/types.ts)、[DSH 动作实现](https://github.com/deepseek-ai/deepseek-harness/blob/504a01a9578abc2c6f1fb896b1dc322c9fe24f66/packages/api/session-controller/src/commands.ts)

具体 Interface 由[两端最小实验](../plans/first-harness-tracer.md)收敛，之后以共同的行为验证保护。固定已验证原生版本；升级先跑对应兼容检查，新语义经能力声明进入产品，不静默沿用旧假设。此边界不要求先建设通用插件平台或抹平全部原生能力。

## 对话约定

一段对话固定工作区、Harness，以及新建时选择的模型和权限；首版需要其他配置时新建对话。跨设备继续、各轮输入及恢复原生会话都遵循同一配置；接入模块核实哪些字段须显式传递、哪些由原生继承。配置无法保持时明确失败，不能静默换模型或创建另一段原生会话。

按原策略处理某次权限审批不改变整段对话的权限配置。追加输入、停止和待处理请求按原生能力表达；不把不同 Harness 的“已接收”统一解释为“已经被当前轮消费”。操作回执与恢复规则归 [ADR 0004](0004-recoverable-communication.md)。

见微等能力通过安装与工作区使用进入产品，投资业务不进入中书核心模型。HTML 原型表达视觉与交互意图；生产代码结构独立设计。
