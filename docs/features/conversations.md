# 创建对话：feature map

当前能力：进入工作区草稿，在输入区选择 Agent Power、模型、思考深度与权限；首条消息发送时才创建固定配置的对话。草稿与默认选择的取舍见 [ADR 0010](../adr/0010-draft-first-conversation.md)，DSH 原生提前准备见 [ADR 0011](../adr/0011-dsh-prepared-session.md)，原生边界见 [ADR 0001](../adr/0001-native-harness-boundary.md)。

## Sub-features

| 场景 | 要证明的行为 |
| --- | --- |
| C01 | 工作区新建直接进入草稿，首发才创建并绑定所选配置 |
| C02 | 每工作区一份草稿，切换、刷新与应用重启不提前创建或串内容 |
| C03 | 首发创建响应丢失后沿同一创建与操作编号核对，不重复提交 |
| C04 | 早期原生绑定后配置失败，材料保留；修复后沿原绑定发送 |
| C05 | 真实 DSH 提前准备空会话并提供首发技能；被动权限上下文不锁住首发 |
| C06 | 无工作区、无历史、浏览器无缓存时有明确可操作入口 |
| C07 | 默认配置按浏览器偏好、最近成功发送历史回退，标题可编辑 |
| C08 | 模型与 effort 联动，Power 独立，默认/复位不虚构能力 |
| C09 | 两端首发图片、文件、技能和上传失败恢复不丢失、不重复 |
| C10 | DSH 准备跨刷新、切换、失败与应用重启复用；占用冲突不串会话 |
| C11 | DSH 新对话选择 Agent 预设（标准或 PTC，默认标准），首发后固定；原生读回一致，不可用的预设不可选、不被替换 |

## How to get to it (user POV)

登录 → 工作区行的“＋”或最外层“新对话” → 草稿页面，无新建弹窗。工作区选择在输入框上方；输入区内“选择 Agent Power”“模型与思考深度”“执行权限”控制首发配置。输入“给 Agent 的消息”，点“发送消息”或 Cmd/Ctrl+Enter，成功后进入已创建对话。首次发送后配置固定。全局入口的工作区与默认选择见 C06/C07；工作区登记见[工作区管理](workspace-management.md)。

## Driving it with Harness

按[共同入口](README.md)启动、初始化、登录独立 fixture。用不超过 32 个字符的唯一首条文本作为合成标题，保存产品对话编号、操作编号和 `inspect` 原生身份。自动标题取首条文字折叠空白后的前 32 个 Unicode 字符；无文字为“新对话”。CLI 按原生创建时的标题选择，页面之后重命名不应被误认为 CLI 原生标题也改变。

| 场景 | 动作 | 判据和独立观察 |
| --- | --- | --- |
| C01 | 在 Fixture A 点“＋”，选择 Codex / Fixture 模型 / medium / Fixture write，输入“配置 A”；发送前 inspect 并读取产品列表。发送后等 hash/标题/正文，再在 B 选 DSH / Fixture 模型 / high / Fixture read 发“配置 B” | 发送前无新增产品对话，Codex 无新增原生对话，DSH 有一份未提交原生准备；发送后每份各一条身份、一次 submit，配置/工作区正确，首条正文恰一份。完整公共快照不含 cwd/binding/details。inspect 不打印工作区；工作区归属用只读 `native.sqlite` 的 `sessions.body.cwd` 读回。complete 各轮收尾 |
| C02 | A 草稿输入文字、选择权限和文件引用，不发送；切到 B 输入不同内容，再查看已有对话、回 A；完整刷新后由 A“＋”恢复。保留浏览器页，停止应用再以同 root/port 重启 | A/B 各自内容与配置保留，未增加产品对话；DSH 复用同工作区未提交准备，Codex 不提前建原生会话。首次发送只建一条正式对话。图片刷新恢复另跑 C09；独立浏览器无这些草稿，明确退出后清空；关页不承诺恢复 |
| C03 | 安装 browser-faults，`zhVerify.dropNext('/api/private/workbench/conversations')`，从草稿发送“丢创建回执”；等错误后保存 journal，刷新并回原工作区草稿，再点“重试核对首条消息” | 创建请求沿同一 id；首条操作沿同一 operationId；产品和原生各一条，用户正文一次，submitCalls=1。错误时输入/配置锁定并可核对，不能另建替代身份。complete 收尾 |
| C04 | 先运行下方 fail-create；草稿发送“部分创建”，等待准备未完成；记录 inspect，刷新回草稿；运行 repair，再点“重试核对首条消息” | 失败时原生身份已保存、submitCalls=0、材料不丢；修复核对后相同原生 ID，一次首发。首次发送前选的配置不得在恢复中改变 |
| C05 | 真实 DSH 草稿选择工作区与 Power，等待技能准备；按 U12 放置并选择合成技能，选不同于 Host 默认的权限后首发 | 发送前原生为空会话、产品历史无正式条目；首发沿用原生身份，权限和技能真实生效。被动权限上下文不永久禁发；真实 queued user work / 未知 next-step 仍阻止下一轮 |
| C06 | 使用全新 fixture root、独立浏览器。无历史但两工作区时点全局新对话；再按工作区管理移除两项空登记，点全局新对话，经“添加工作区”登记一个合成目录 | 多工作区无历史时要求明确选择；零工作区显示“先添加工作区，再开始对话”，发送不可用；登记成功进入该工作区草稿，不自动创建会话。仅一个工作区且无历史的新上下文自动选该区。没有允许登记根时展示配置说明，不出现死按钮 |
| C07 | A 成功发送并 complete，B 再成功发送并 complete；回 A 再发一轮使 A 最新。用全新独立浏览器登录，点全局新对话；再点 B“＋”；在已有对话“管理对话”改标题并刷新 | 无缓存全局回退 A（按 accepted 消息而非对话创建时间），B 入口回退 B 配置；只读历史不改变最近成功发送排序。旧 DSH 配置的模型/effort 正确显示。重命名持久化且不改变配置/身份。无效/移除配置明确要求重选，不静默换权限；fixture 没有让模型或权限失效的控制命令，这一条只在真实 Harness 下架模型时可观察，fixture 中记 UNCOVERED |
| C08 | fixture 中 Codex 选 ultra，再换 Fixture Alternate（仅 low/medium/high），核对应用其可靠默认 low，再明确选 high；切 DSH 选 off/high，再切回。用“恢复默认模型与深度”及模型列表“默认”；首发后 inspect。另在两个真实 Harness 重跑并独立读回原生配置 | 只出现当前模型实际支持档位；Power 间不带入不兼容值，切回保留各自选择；可靠默认缺失时不编造默认，要求明确选值。首发原生读取与页面选择一致；旧对话不因此重配。fixture Codex 默认是 fixture-model / medium，Alternate 默认 low；DSH 未给可靠默认，不得偷偷选择 off。真实 DSH 必须读回 Host default 和各模型 defaultEffort，验证默认/复位/切模型，而不能套用 fixture 的无默认前提。fixture 只证明选择/绑定语义，不能替代真实端验收 |
| C09 | 在两端草稿加入合成图片、文件引用（输入 `@` 也会打开文件选择）与 `/` 选定技能；DSH 等待准备完成，刷新/切换后确认材料，首发。分别在上传期间断网（安装 [browser-faults](../../test/support/browser-faults.js)，用 `zhVerify.dropNext`/`holdNext`/`rejectNextRequest` 在首发创建或 operations 请求上注入失败）、恢复后核对/重试；另在首发前由可信端删除所引用的文件 | 首发前仅浏览器暂存图片；失败有可见提示、可恢复，不静默只发文本；首发后原生实际看到图片/引用/技能（用 U04/U07/U12 独立证据），文本及材料各一次。引用文件被删时服务端明确拒绝首发：页面进入已创建的对话，提示原因，输入和其余材料可直接编辑，没有“核对同一发送”，operations 为空。这样建好但还没跑过一轮的 Codex 对话，稍后刷新、切走再回来，仍显示就绪，可以发送、归档（Codex 在首轮之前读回的思考深度为空，中书只接受这一项空缺，首轮由 `turn/start` 明确带上）。DSH 首发技能按 C05，不假造技能；缺真实能力记录 BLOCKED。fixture 的 Codex 与 DSH 都能发现合成技能（`GET /draft-skills?workspaceId=a&harnessId=codex` 返回 zhi-proof / zhi-secondary，输入 `/` 可选；无技能工作区才显示“没有匹配的技能”）；fixture 原生会话只记录文字（含引用说明），不记录图片，所以“原生看到图片”只能在真实端用 U04 证明 |
| C11 | 用没有浏览器偏好和发送历史的独立上下文：草稿选 DSH 后配置栏出现「Agent 预设」，默认「标准」，以默认首发一段；再开一段改选 PTC 后首发，然后打开第三个草稿。已有对话打开配置浮层 | 首发请求的 `agentPreset` 与所选一致，未选时为 `standard`；预设和模型、权限一样按 C07 回退，PTC 首发后的新草稿默认 PTC（「默认标准」只指没有偏好和历史时）；已有对话只显示预设，不能改。真实 DSH 另用 `session/follow` 读回原生预设一致，Host 不可用的预设显示为不可选且不被替换。fixture 的 DSH 提供标准与 PTC，只能证明选择、默认与请求内容，不能证明原生读回 |

```sh
node test/support/feature-fixture.ts fail-create --root "$zh_verify_root"
# 页面发送短唯一文本“部分创建”，观察失败后：
node test/support/feature-fixture.ts inspect --root "$zh_verify_root" --title '部分创建'
node test/support/feature-fixture.ts repair --root "$zh_verify_root" --title '部分创建'
```

### C10 / DSH 原生准备与恢复

1. 独立现场中在 Fixture A 草稿选择 DSH。观察页面发起带 CSRF 的 `POST /api/private/workbench/draft-preparation`，返回只含 preparationId 与技能，不含原生绑定。只读应用库 `workbench_draft_preparations` 的 workspace_id、preparation_id、native_id、claimed_by，核对 preparationId 与 native_id 不同、claimed_by 为空；产品对话列表无新增。原生 fixture 可用只读 `native.sqlite` sessions 或其 inspect 核对空输入。
2. 输入带唯一标记的草稿，刷新、切 Power 后切回、切工作区后回来（需要两个自己登记的工作区，不要切到别人的工作区，那会在那里建原生准备）；记录每工作区准备身份，再重复五次。每工作区仍只有同一个未占用准备；文字和技能标记保留，不出现正式历史。停止并重启本次应用后沿同一身份恢复。真实 DSH 分支用 session/list 与 session/follow 对照空会话、cwd、无用户轮；只在自己拥有的独立 Host 上追加 Host 重启分支。
3. 使用共同故障工具 `zhVerify.dropNext('/api/private/workbench/draft-preparation')`，触发页面“重试准备首发技能”或重新进入尚未提交的草稿。丢回执后重试、刷新，仍沿原准备编号；服务器不可用时提示未完成且保稿。恢复前不发送，恢复后真实技能目录可选。首次已经加载完成时需重新进入才能触发查询，不以没有发生请求当作故障通过。
4. 在两个独立浏览器上下文打开同工作区 DSH 草稿，核对共享未占用准备。A 从页面首发，原生输入及正式对话各一份；B 保留旧准备发送，应明确未发送并允许“重新准备首发技能”，不占用 A 的对话。重新准备后核验旧技能是否仍适用，再由用户重选/发送；新的正式对话身份独立。首发回执丢失按 C03 驱动，不能把明确拒绝与未知结果混为一类。
5. 准备后的首发前可调整模型/深度/权限，实际原生绑定须与最终选择一致；选技能后切 Power 或工作区不携带错误身份提交。只读库检查已占用准备的归属与正式绑定一致。旧格式无 preparationId 的对话保持可接续，不改写历史配置。

此方法以有界复用控制未提交资源：每工作区一份准备槽，实例总计最多 256 份（含已移除工作区保留槽）；已占用会话归正式对话，下一草稿才轮换该槽。达到上限拒绝新准备，不删除未知会话腾空间，不承诺原生删除 API 或按时间回收。未登录或无 CSRF 的准备请求应拒绝且不创建资源；工作区移除、维护或保存期间不得绕过已有执行门禁。原生准备被外部写入后必须阻断复用，不能隐藏地创建替代会话。

### 空原生会话故障前提

E02/E04 的指定会话回执控制、R04 的 `seed` 要求原生会话存在但尚未接收消息。fixture 中用 C04 的 fail-create，草稿首发短唯一标题，确认失败且 submitCalls=0；运行 repair 后点“查看已创建的对话”（不要点重试核对）。等就绪，保存 hash/inspect，清空转交到输入框的合成文字，再施加各场景故障。R04 在此时 seed。这个步骤只建立故障前提，不算正常新建路径通过；正常首发必须另跑 C01。不要手写产品数据库或用 API 偷建替代用户动作。

C03 丢的是浏览器 HTTP 回执；C04 在 onBound 后失败。原生 Host 创建前后崩溃是另一实验，不能互相替代。

## Gotchas

- 新建页面不是正式对话；Codex 不提前建线程，DSH 首发前准备原生空会话，但不提交用户任务或进入产品历史。
- 本地草稿/偏好不作为权限依据，服务端派发前仍校验工作区、模型和 effort。默认来源与失效处理按 C07/C08 单独验证。
- 模型目录约缓存 30 秒；对话标题栏「对话操作」中的“重新连接并刷新状态”不强制绕过缓存。
- 工作区是登记 allowlist；目录隔离不等于操作系统权限沙箱。
- DSH 技能以准备会话的原生目录为准。每工作区至多保留一份未占用准备，首发原子占用；旧草稿不能抢占已占用身份。失联时保留编号核对，不盲目回收。
- 创建未知、准备失败、上传失败、发送回执未知是不同阶段；材料和编号的恢复要逐段记录。
- **Agent 预设（C11，[ADR 0017](../adr/0017-dsh-agent-preset.md)）。**
  - 驱动：输入框配置栏在 DSH 下多一个「Agent 预设」，默认「标准」，可改为 PTC。普通新建经 `session/create` 的 `agentPreset` 指定。
  - 草稿提前准备的空会话，在首发时经 `agentPresets/select` 改为所选；首轮开始后原生会锁定。
  - 读回：原生 `session/follow` 快照中 `projections.values.agentPreset` 应等于对话配置中的 `agentPreset`；不一致时对话停止派发并说明。
  - 预设之前建的对话没有这个字段，按 Host 当时的默认运行，标签不显示预设。
  - PTC 下，Agent 用 `run_code` 脚本调用工具。每次子调用（原生 `tool/ptc-dispatch`）在工具过程中单独显示，带工具名、参数和输出。

## Implementation and regression

- 草稿页与首发生命周期：[new-conversation.tsx](../../src/web/new-conversation.tsx)；草稿身份：[new-conversation-state.ts](../../src/web/new-conversation-state.ts)；偏好与标题：[conversation-preferences.ts](../../src/web/conversation-preferences.ts)。
- 配置交互：[draft-configuration.tsx](../../src/web/patterns/draft-configuration.tsx)；工作台导航：[workbench.tsx](../../src/web/workbench.tsx)。
- 创建、默认历史、草稿能力：[creation.ts](../../src/server/workbench/creation.ts)、[workbench-http.ts](../../src/server/workbench-http.ts)；不可变配置与接受记录：[workbench-store.ts](../../src/server/workbench-store.ts)。
- 原生 effort 与技能：[Codex](../../src/harness/codex/index.ts)、[DSH](../../src/harness/dsh/index.ts)。
- `node --test test/workbench.test.ts test/workbench-store.test.ts test/workbench-http.test.ts test/codex.test.ts test/dsh.test.ts` 只证明测试覆盖的状态与协议边界，不等于浏览器或真实 Harness 已通过。
