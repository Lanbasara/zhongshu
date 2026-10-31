# 创建对话：feature map

范围：从操作者允许的工作区与实际原生目录创建一段配置固定的对话。原生边界归 [ADR 0001](../adr/0001-native-harness-boundary.md)。

## Sub-features

- 选择工作区、Agent、模型与权限：以当前目录提供的选项为准。
- 创建对话：创建后进入同一标题/对话，绑定原生身份。
- 空对话恢复：创建后不发消息，刷新并重启中书，再打开同一对话发首条消息。
- 权限变化后的首条发送：DSH 权限设置产生的被动上下文不应锁住发送。
- 回执未知或部分失败：中断创建/配置窗口后，页面按同一编号核对。

## How to get to it (user POV)

1. 登录后点“＋ 新对话”或“开始新对话”。
2. 填写名称，选择工作区、Agent、模型、权限，点“创建对话”。
3. 创建成功后进入对话；实际发送首条消息才能确认可用。

## Driving it with Harness

先按 [features/README](README.md) 准备独立现场，并为 Codex、DSH 分别准备内容相同但目录独立的合成工作区。

1. 确认 Host 已登录、配置可读、目录真实存在。
2. 从页面选择本轮实际可用的配置，创建后核对工作区、绑定和配置。
3. 先不发消息，刷新并重启本次应用，再打开同一对话发首条消息；仍使用原生同一身份。
4. DSH 选择与 Host 默认不同且适合测试工作区的权限，创建后发送一条合成请求。
5. 在可定位的创建/配置窗口中断连接，页面“核对创建结果”沿同一编号核对。

## Gotchas

- **空历史不代表读取失败。** Codex 空会话也可能有有效原生绑定。
- **创建成功不等于可发送。** 配置未核实前不能发送；必须先实际发一条。
- **浏览器只暴露工作区 ID。** 不要泄露原生连接秘密或真实路径。
- **配置在对话内固定。** 模型/权限不能在已有对话中跨 Harness 无损切换；需要时新建对话。
- **权限设置产生的被动上下文不是阻塞消息。** 原生真实待处理输入仍须阻塞。
- **取得原生绑定后要保留。** 即使后续配置失败，也不能自动创建替代会话。
- **侧栏出现一条记录不能证明原生创建成功。** 核对绑定/原生创建次数。

## Implementation and regression

- 创建、配置与绑定：[workbench.ts](../../src/server/workbench.ts)、[harness-config.ts](../../src/server/harness-config.ts)
- Codex 适配：[codex/index.ts](../../src/harness/codex/index.ts)
- DSH 适配：[dsh/index.ts](../../src/harness/dsh/index.ts)
- 共同语义：[harness/types.ts](../../src/harness/types.ts)
- 回归：[workbench.test.ts](../../test/workbench.test.ts)、[codex.test.ts](../../test/codex.test.ts)、[dsh.test.ts](../../test/dsh.test.ts)
