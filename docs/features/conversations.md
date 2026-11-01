# 创建对话：feature map

当前能力：从操作者允许的工作区和 Harness 目录创建配置固定的对话，保留早期原生绑定，并恢复空对话。原生边界与固定配置的理由见 [ADR 0001](../adr/0001-native-harness-boundary.md)。

## Sub-features

| 场景 | 要证明的行为 |
| --- | --- |
| C01 | 工作区、Harness、模型和权限来自目录；新对话绑定所选配置 |
| C02 | 空对话在刷新、应用重启后仍可发送首条消息 |
| C03 | 创建响应丢失后，仍按同一对话编号核对 |
| C04 | 原生身份已建立但后续配置失败时，保留绑定、阻止发送；恢复时不另建原生会话 |
| C05 | 真实 DSH 权限设置产生的被动上下文不锁住首条发送 |

## How to get to it (user POV)

登录 →“＋ 新对话”（空工作台也可点“开始新对话 ↗”）→“对话名称”“工作区”“Agent”“模型”“权限”→“创建对话 ↗”。创建返回后对话可能仍“正在准备”；必须等待可发送，实际发送首条消息后才知道执行链路可用。当前没有编辑既有对话模型/权限或管理工作区目录的页面。

## Driving it with Harness

先按 [共同入口](README.md) 启动、初始化、登录 fixture。每个场景用唯一对话名，记录所选工作区/Harness/模型/权限、地址 hash 和 `inspect` 原生身份。不要只记录侧栏标题。

| 场景 | 动作 | 判据和独立观察 |
| --- | --- | --- |
| C01 | 建“配置 A”：Fixture A / Codex / Fixture 模型 / Fixture write；再建“配置 B”：Fixture B / DSH / Fixture read | 页面进入对应标题、工作区和就绪状态；`inspect` 中两条身份不同、配置分别与所选一致；产品快照 `workspaceId/harnessId/configuration` 一致。完整快照不含 `cwd/binding/details`；fixture 结果只证明应用选择与绑定语义 |
| C02 | 建“空对话”，先不发消息；保存 hash 和 fixture 身份，刷新，然后停止应用并用相同 root/port 重启；再进入此 hash，发送“首条消息” | 恢复后仍为空且就绪；fixture 身份不变，只有一条会话；首次提交只产生一次 submit，进入运行中。随后按 E01 complete 收尾 |
| C03 | 安装 browser-faults，执行 `zhVerify.dropNext('/api/private/workbench/conversations')`，建“丢创建回执”；等错误后不关对话框，再次 arm 同一 drop 并点“核对创建结果”。保存 journal，再 restore 并第三次核对 | journal 中两次创建请求使用同一 `id`；正常返回后产品列表只有一条该 ID，`inspect` 只有一个对应原生身份。首次原生创建可能延后，条件等待就绪；不能以一次侧栏出现判通过 |
| C04 | 运行下面的 fail-create，再建“部分创建”；等待“准备未完成”，记录 inspect 身份；运行 repair，再点“查询原生结果”或“重新连接” | 失败时输入可保留但不能派发消息，`configurationVerified: false`；恢复后 ready、可发送。前后 `inspect` 同一原生 ID，未增加会话；已有绑定不能被第二次 create 替代 |
| C05 | 按共同入口准备真实 DSH；选与 Host 默认不同的权限，创建空对话并发送合成请求；独立读回原生身份/配置与首条消息 | 首条消息实际进入原生历史并完成；被动上下文不使页面永久禁发。真实 queued user work / 未知 next-step 输入仍须阻止下一轮；不要清空它们来换取通过 |

```sh
node test/support/feature-fixture.ts fail-create --root "$zh_verify_root"
# 通过页面创建“部分创建”并观察失败后：
node test/support/feature-fixture.ts inspect --root "$zh_verify_root" --title '部分创建'
node test/support/feature-fixture.ts repair --root "$zh_verify_root" --title '部分创建'
```

C03 的 drop 只丢浏览器收到的 HTTP 回执，不等同于 Host 在创建前后崩溃。C04 则精确在 fixture 调用 `onBound` 后使配置失败；这两种故障需分别记录。C05 没有真实 DSH 时记录 `BLOCKED`，不能用 fixture 的 DSH 选项替代。

## Gotchas

- 空历史不是读取失败；当前实现能给空 Codex 会话命名并保存原生 rollout。
- 对话框“核对创建结果”只重试当前未关闭表单里的稳定编号。关闭后重开不承诺保留该编号；不要把重开表单称为同一次核对。
- 配置列表缓存约 30 秒；“重新连接”不强制绕过服务端目录缓存。升级/连接变动后等待刷新，不能立即断言新目录失效。
- 工作区下拉是已登记的 allowlist，当前无“任意选择本机目录”能力；目录隔离不等于操作系统权限沙箱。
- 完整配置失败、原生创建结果未知、网络回执丢失是不同状态；没有已有绑定的未知创建不能安全地自动另建。

## Implementation and regression

- 表单、稳定创建 ID：[workbench.tsx](../../src/web/workbench.tsx) 的 `CreateConversation`。
- 创建/准备/启动恢复：[workbench.ts](../../src/server/workbench.ts) 的 `create/prepare/start`；allowlist：[harness-config.ts](../../src/server/harness-config.ts)。
- 早期绑定与配置验证：[codex/index.ts](../../src/harness/codex/index.ts)、[dsh/index.ts](../../src/harness/dsh/index.ts)；持久化：[workbench-store.ts](../../src/server/workbench-store.ts)。
- `node --test test/workbench.test.ts test/codex.test.ts test/dsh.test.ts`：重点看绑定先于配置失败、空 Codex rollout、DSH passive context 与真正排队输入的反例。原生协议替身测试不等于 C05 真实接入。
