---
status: accepted
---

# DSH 的 Agent 预设在新建对话时选定，只提供标准与 PTC

## 背景与依据

2026-11-07，用户希望 DSH 至少默认使用标准或 PTC 模式，能简单切换更好；不需要任意选择全部模式，也不需要新增模式。用户确认：新建 DSH 对话时可以选择标准或 PTC，默认标准。

当前代码新建 DSH 会话时不指定预设，跟随 Host 的默认设置。

在固定兼容版本上对照源码核实（未在真实 Host 运行）：

- web 构成内置标准、PTC、极简、创造四种预设，出厂默认为标准。
- 新建会话可以指定预设，也可以读取 Host 上的预设列表。
- 预设只能在首轮开始前选择，开始后被锁定。
- PTC 在标准的基础上，改为让 Agent 用脚本批量调用工具。

依据：[DSH 会话请求](https://github.com/deepseek-ai/deepseek-harness/blob/504a01a9578abc2c6f1fb896b1dc322c9fe24f66/packages/api/session-controller/src/types.ts)、[DSH 预设登记](https://github.com/deepseek-ai/deepseek-harness/blob/504a01a9578abc2c6f1fb896b1dc322c9fe24f66/packages/preset/agent-preset-registry/src/index.ts)、[web 构成的内置预设](https://github.com/deepseek-ai/deepseek-harness/tree/504a01a9578abc2c6f1fb896b1dc322c9fe24f66/packages/bundle/web-app/presets)。这些是协议依据，不替代目标版本的真实验证。

## 决定

- **固定配置。** 预设成为 DSH 对话的固定配置：和模型、权限一样，在新建时确定，之后不能改（[ADR 0001](0001-native-harness-boundary.md)、[ADR 0010](0010-draft-first-conversation.md)）。草稿预先准备的空会话，在首次发送时按最终选择设定（[ADR 0011](0011-dsh-prepared-session.md)）。
- **可选范围与默认。** 只提供标准与 PTC。中书的新草稿默认标准，与 Host 的默认设置无关。
- **不可用时。** Host 没有提供某个预设，或该预设损坏时，它明确显示为不可选；不静默换成另一个预设。
- **已有对话。** 已有对话按原生记录的预设显示，不重新配置。
- Codex 不受本决定影响。

## 取舍与后果

| 被放弃的方案 | 原因 |
| --- | --- |
| 开放全部预设，或允许新增预设 | 用户不需要；极简与创造的工具差异大，展示和验证成本高 |
| 跟随 Host 的默认设置 | 中书和原生界面的默认可能不同步，用户难以判断新对话用的是哪种 |
| 不提供选择，固定为标准 | 用户希望能简单切换；原生接口支持在新建时指定 |

后果：

- 对话的配置契约增加预设字段，旧数据缺少这一字段时仍然可读。
- PTC 下的工具过程要单独核对展示效果。
