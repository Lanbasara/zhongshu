# 创建对话：feature map

当前能力：进入工作区草稿，在输入区选择 Agent Power、模型、思考深度与权限；首条消息发送时才创建固定配置的对话。草稿与默认选择的取舍见 [ADR 0010](../adr/0010-draft-first-conversation.md)，原生边界见 [ADR 0001](../adr/0001-native-harness-boundary.md)。

## Sub-features

| 场景 | 要证明的行为 |
| --- | --- |
| C01 | 工作区新建直接进入草稿，首发才创建并绑定所选配置 |
| C02 | 每工作区一份草稿，切换、刷新与应用重启不提前创建或串内容 |
| C03 | 首发创建响应丢失后沿同一创建与操作编号核对，不重复提交 |
| C04 | 早期原生绑定后配置失败，材料保留；修复后沿原绑定发送 |
| C05 | 真实 DSH 被动权限上下文不锁住首发；创建前准确提示技能限制 |
| C06 | 无工作区、无历史、浏览器无缓存时有明确可操作入口 |
| C07 | 默认配置按浏览器偏好、最近成功发送历史回退，标题可编辑 |
| C08 | 模型与 effort 联动，Power 独立，默认/复位不虚构能力 |
| C09 | 首发图片、文件、Codex 技能和上传失败恢复不丢失、不重复 |

## How to get to it (user POV)

登录 → 工作区行的“＋”或最外层“新对话” → 草稿页面，无新建弹窗。工作区选择在输入框上方；输入区内“选择 Agent Power”“模型与思考深度”“执行权限”控制首发配置。输入“给 Agent 的消息”，点“发送消息”或 Cmd/Ctrl+Enter，成功后进入已创建对话。首次发送后配置固定。全局入口的工作区与默认选择见 C06/C07；工作区登记见[工作区管理](workspace-management.md)。

## Driving it with Harness

按[共同入口](README.md)启动、初始化、登录独立 fixture。用不超过 32 个字符的唯一首条文本作为合成标题，保存产品对话编号、操作编号和 `inspect` 原生身份。自动标题取首条文字折叠空白后的前 32 个 Unicode 字符；无文字为“新对话”。CLI 按原生创建时的标题选择，页面之后重命名不应被误认为 CLI 原生标题也改变。

| 场景 | 动作 | 判据和独立观察 |
| --- | --- | --- |
| C01 | 在 Fixture A 点“＋”，选择 Codex / Fixture 模型 / medium / Fixture write，输入“配置 A”；发送前 inspect 并读取产品列表。发送后等 hash/标题/正文，再在 B 选 DSH / Fixture 模型 / high / Fixture read 发“配置 B” | 发送前无新增产品或原生对话；发送后每份各一条身份、一次 submit，配置/工作区正确，首条正文恰一份。完整公共快照不含 cwd/binding/details。complete 各轮收尾 |
| C02 | A 草稿输入文字、选择权限和文件引用，不发送；切到 B 输入不同内容，再查看已有对话、回 A；完整刷新后由 A“＋”恢复。保留浏览器页，停止应用再以同 root/port 重启 | A/B 各自内容与配置保留，未增加产品/原生会话。首次发送只建一条。图片刷新恢复另跑 C09；独立浏览器无这些草稿，明确退出后清空；关页不承诺恢复 |
| C03 | 安装 browser-faults，`zhVerify.dropNext('/api/private/workbench/conversations')`，从草稿发送“丢创建回执”；等错误后保存 journal，刷新并回原工作区草稿，再点“重试核对首条消息” | 创建请求沿同一 id；首条操作沿同一 operationId；产品和原生各一条，用户正文一次，submitCalls=1。错误时输入/配置锁定并可核对，不能另建替代身份。complete 收尾 |
| C04 | 先运行下方 fail-create；草稿发送“部分创建”，等待准备未完成；记录 inspect，刷新回草稿；运行 repair，再点“重试核对首条消息” | 失败时原生身份已保存、submitCalls=0、材料不丢；修复核对后相同原生 ID，一次首发。首次发送前选的配置不得在恢复中改变 |
| C05 | 真实 DSH 草稿选不同于 Host 默认的权限；观察“首次发送后可选择技能”，手打 `/文本` 保持普通文字。发送合成首条消息，完成后再按 U12 选技能 | 草稿阶段没有 DSH 原生会话/技能目录假数据；首发进入原生历史并完成，被动权限上下文不永久禁发。已有会话技能可用；真实 queued user work / 未知 next-step 仍阻止下一轮 |
| C06 | 使用全新 fixture root、独立浏览器。无历史但两工作区时点全局新对话；再按工作区管理移除两项空登记，点全局新对话，经“添加工作区”登记一个合成目录 | 多工作区无历史时要求明确选择；零工作区显示“先添加工作区，再开始对话”，发送不可用；登记成功进入该工作区草稿，不自动创建会话。仅一个工作区且无历史的新上下文自动选该区。没有允许登记根时展示配置说明，不出现死按钮 |
| C07 | A 成功发送并 complete，B 再成功发送并 complete；回 A 再发一轮使 A 最新。用全新独立浏览器登录，点全局新对话；再点 B“＋”；在已有对话“管理对话”改标题并刷新 | 无缓存全局回退 A（按 accepted 消息而非对话创建时间），B 入口回退 B 配置；只读历史不改变最近成功发送排序。旧 DSH 配置的模型/effort 正确显示。重命名持久化且不改变配置/身份。无效/移除配置明确要求重选，不静默换权限 |
| C08 | fixture 中 Codex 选 ultra，再换 Fixture Alternate（仅 low/medium/high），核对应用其可靠默认 low，再明确选 high；切 DSH 选 off/high，再切回。用“恢复默认模型与深度”及模型列表“默认”；首发后 inspect。另在两个真实 Harness 重跑并独立读回原生配置 | 只出现当前模型实际支持档位；Power 间不带入不兼容值，切回保留各自选择；可靠默认缺失时不编造默认，要求明确选值。首发原生读取与页面选择一致；旧对话不因此重配。fixture Codex 默认是 fixture-model / medium，Alternate 默认 low；DSH 未给可靠默认，不得偷偷选择 off。fixture 只证明选择/绑定语义，不能替代真实端验收 |
| C09 | 在未创建的 Codex 草稿加入合成图片、文件引用与 `/` 选定技能；刷新/切换后确认材料，首发；DSH 用图片/文件同样驱动。分别在上传期间断网、恢复后核对/重试 | 首发前仅浏览器暂存图片；失败有可见提示、可恢复，不静默只发文本；首发后原生实际看到图片/引用/技能（用 U04/U07/U12 独立证据），文本及材料各一次。DSH 创建前技能限制按 C05，不假造技能；缺真实能力记录 BLOCKED |

```sh
node test/support/feature-fixture.ts fail-create --root "$zh_verify_root"
# 页面发送短唯一文本“部分创建”，观察失败后：
node test/support/feature-fixture.ts inspect --root "$zh_verify_root" --title '部分创建'
node test/support/feature-fixture.ts repair --root "$zh_verify_root" --title '部分创建'
```

### 空原生会话故障前提

E02/E04 的指定会话回执控制、R04 的 `seed` 要求原生会话存在但尚未接收消息。fixture 中用 C04 的 fail-create，草稿首发短唯一标题，确认失败且 submitCalls=0；运行 repair 后点“查看已创建的对话”（不要点重试核对）。等就绪，保存 hash/inspect，清空转交到输入框的合成文字，再施加各场景故障。R04 在此时 seed。这个步骤只建立故障前提，不算正常新建路径通过；正常首发必须另跑 C01。不要手写产品数据库或用 API 偷建替代用户动作。

C03 丢的是浏览器 HTTP 回执；C04 在 onBound 后失败。原生 Host 创建前后崩溃是另一实验，不能互相替代。

## Gotchas

- 新建页面不是服务器空对话；查看历史和切换草稿不应产生原生身份。
- 本地草稿/偏好不作为权限依据，服务端派发前仍校验工作区、模型和 effort。默认来源与失效处理按 C07/C08 单独验证。
- 模型目录约缓存 30 秒；“重新连接”不强制绕过缓存。
- 工作区是登记 allowlist；目录隔离不等于操作系统权限沙箱。
- DSH 创建前无原生技能目录能力；不能偷偷创建临时会话换取下拉选项。
- 创建未知、准备失败、上传失败、发送回执未知是不同阶段；材料和编号的恢复要逐段记录。

## Implementation and regression

- 草稿页与首发生命周期：[new-conversation.tsx](../../src/web/new-conversation.tsx)；草稿身份：[new-conversation-state.ts](../../src/web/new-conversation-state.ts)；偏好与标题：[conversation-preferences.ts](../../src/web/conversation-preferences.ts)。
- 配置交互：[draft-configuration.tsx](../../src/web/patterns/draft-configuration.tsx)；工作台导航：[workbench.tsx](../../src/web/workbench.tsx)。
- 创建、默认历史、草稿能力：[workbench.ts](../../src/server/workbench.ts)、[workbench-http.ts](../../src/server/workbench-http.ts)；不可变配置与接受记录：[workbench-store.ts](../../src/server/workbench-store.ts)。
- 原生 effort 与技能：[Codex](../../src/harness/codex/index.ts)、[DSH](../../src/harness/dsh/index.ts)。
- `node --test test/workbench.test.ts test/workbench-store.test.ts test/workbench-http.test.ts test/codex.test.ts test/dsh.test.ts` 只证明测试覆盖的状态与协议边界，不等于浏览器或真实 Harness 已通过。
