# 工作单索引

spec 是与用户讨论后确认的临时约定：它回答“接下来建什么、范围是什么、怎样算完成”。Agent 可以起草，但未确认的内容不能写成事实。当前事实在 [feature maps](../features/README.md)，长期取舍在 [ADR](../adr/)。状态只在这里维护。

## 当前切片

| 切片 | 用户行为 | 状态 | 退出条件 | 证据 | 更新 |
| --- | --- | --- | --- | --- | --- |
| [原生体验补齐](native-experience.md) | 正确阅读工具过程，使用 DSH 原生默认并在首发选技能 | active | 三项真实路径、恢复反例和独立验收通过，用户确认 | none yet；已授权实施，验收进行中 | 2026-11-06 |
| [新对话草稿与思考深度](draft-first-conversation.md) | 直接进入草稿，输入区配置 Power/模型/深度，首次发送才创建 | active | 两端真实路径、旧数据兼容与独立验收通过 | [PR #34](https://github.com/Lanbasara/zhongshu/pull/34)，已实现并取得本地及独立验证证据，待用户试用 | 2026-11-06 |
| 界面重设计 | 从头设计信息结构、视觉、组件与动效，功能全部保留；2–3 段并行对话一眼可辨，未读完成跨设备同步 | done | 新界面覆盖全部现有功能，作者浏览器走通桌面与手机路径，用户在测试实例完成手机与跨端（含未读同步）验收 | [PR #38](https://github.com/Lanbasara/zhongshu/pull/38)；用户 2026-11-07 在测试实例验收通过；未做独立执行验收（用户决定） | 2026-11-07 |
| 主界面与设计系统 | 用统一设计完成真实对话，隔离展示公共组件 | done | 本轮实现及已声明验证范围经用户认可；未覆盖项见 PR | [PR #18](https://github.com/Lanbasara/zhongshu/pull/18) | 2026-11-03 |
| 首条 Agent 曳光弹 | 选 Codex 或 DSH，完成真实工作，关页后接续；必要时停止 | done | 本机两 Harness 完成真实工作、关页或应用中断后接续；目标设备与部署链路分别有证据 | PR #5、#6、#9；[发布检查](https://github.com/Lanbasara/zhongshu/actions/runs/41433423972)；目标设备与部署链路已由用户验收 | 2026-11-02 |
| [对话基本可用性](conversation-usability.md) | 读正文与工具过程、收发图片，用顺手的输入框引用消息与工作区原文件 | active | 两端真实用户路径与恢复验收，用户试用确认 | [PR #13](https://github.com/Lanbasara/zhongshu/pull/13) | 2026-11-02 |
| 会改变架构的接入实验 | 回答追加、文件保存、HTML 阅读等会改变实现的问题 | next | 每个问题有结论，决定进入 ADR | none yet | 2026-10-31 |
| [工作区管理](workspace-management.md) | 添加已有或新建的目录，改名、置顶、搜索、移除和恢复工作区 | active | 见工作单退出条件 | 见工作单 | 2026-11-03 |
| 运行中排队与追加输入 | 运行中排多条消息，逐条提前发送并核对归属轮次 | done | 两个真实 Harness 的队列、轮尾竞争和回执恢复通过独立执行 | [PR #19](https://github.com/Lanbasara/zhongshu/pull/19) · [执行地图](../features/execution.md#e06--e07-排队与提前发送) | 2026-11-03 |
| [原生子 Agent 的查看与停止](native-subagents.md) | 在对话中查看主 Agent 派生的子 Agent 与 DSH 团队，单独停止子 Agent | active | 两端真实派生、停止、恢复与待核实反例经独立验收，用户试用确认 | 已实现；用户已试用；两端 fixture 与真实 Host 独立验收通过；Codex Host 重启、嵌套/外部子 Agent、真机未覆盖 | 2026-11-06 |
| Agent 提问与审批 | 任何权限下都能回答 DSH Agent 的提问；工作区读写与只读时审批，完全访问时全部允许；含 Codex 子 Agent 的审批（[ADR 0016](../adr/0016-questions-and-approvals.md)）。用户决定完成后再正式开始日常使用 | done | DSH 主 Agent 的提问与两端按权限出现的审批都在中书得到一次有效回答，完全访问不出现审批；恢复与多端反例有真实 Host 证据，用户在测试实例验收确认 | [PR #40](https://github.com/Lanbasara/zhongshu/pull/40)；两端真实 Host 探针与作者浏览器自测通过；用户 2026-11-07 在测试实例完成手机与跨端验收；未做独立执行验收（用户决定）；未覆盖：Codex 子 Agent 审批与 MCP 信息请求的真实运行 · [执行地图 E08–E10](../features/execution.md#e08e10-提问与审批) | 2026-11-07 |
| Plan 模式 | 两端在输入区开关 Plan，审核计划后再执行；Codex 的结构化提问随本切片接入，复用提问卡片（[ADR 0016](../adr/0016-questions-and-approvals.md)） | done | 两端真实 Host 完成 Plan 的开启、规划、提问（含 Codex 结构化提问）、计划审核与执行的往返，开关跨设备一致，用户在测试实例验收确认 | [PR #41](https://github.com/Lanbasara/zhongshu/pull/41)；两端真实 Host 探针与接口端到端通过；用户 2026-11-07 在测试实例验收通过（DSH），其间发现并修复切换 Plan 后发送被挡；作者浏览器自测因 Canary 调试连接被拒未做；未做独立执行验收（用户决定） · [执行地图 E11–E13](../features/execution.md#e11e13-plan-模式) | 2026-11-07 |
| 通知与安装 | 安装成独立窗口；离开页面后收到完成、失败、等待回答或审批的推送，通知显示对话标题；账号提醒随 Harness 账号切片接通（[ADR 0018](../adr/0018-push-notifications.md)） | done | 安装、开启与移除推送、三类触发和点击直达有证据，通知不含消息、提问或文件内容；用户试用后接受现状 | [PR #42](https://github.com/Lanbasara/zhongshu/pull/42)；作者在真实 Host 与真实推送服务上自测通过。用户 2026-11-07 在测试实例的一加手机上收到测试通知与完成提醒，接受现状：该机 Play 商店拒装 WebAPK，安装降级为快捷方式；划掉后 ColorOS 冻结 Chrome，提醒会延迟；通知横幅与振动由系统设置决定。未做独立执行验收（用户决定）；电脑端与点击直达未由用户验收 · [通知地图](../features/notifications.md) | 2026-11-07 |
| Harness 账号 | 在设置中查看两端账号状态，需要处理时得到提醒（含推送）；Codex 在页内用设备码续登，DSH 在页内粘贴跳转地址续登，并提供用量与充值链接（[ADR 0015](../adr/0015-harness-account-status.md)） | done | 两端真实状态与原生一致，失效能识别并提醒；Codex 真实设备码续登成功；凭据、用户码与粘贴地址不出现在日志和数据库 | [PR #43](https://github.com/Lanbasara/zhongshu/pull/43)。作者在隔离与本机真实 Host 上自测通过；用户 2026-11-07 在隔离 Codex 上完成真实设备码登录，在测试实例看到 DSH 状态。DSH 的“可用”与登录在本机受公司 TLS 代理阻断，用户决定留到发布时验证：2026-11-07 发布到服务器后，DSH 核实为可用（服务器上资料接口被 DeepSeek 边缘拦截，由 [PR #45](https://github.com/Lanbasara/zhongshu/pull/45) 改用余额读取核实），页内登录可发起到 DeepSeek 登录页；未用真实账号完成整次粘贴登录，因为会替换正在使用的有效凭据。未做独立执行验收（用户决定） · [账号地图](../features/harness-accounts.md) | 2026-11-07 |
| DSH Agent 预设 | 新建 DSH 对话时选择标准或 PTC，默认标准（[ADR 0017](../adr/0017-dsh-agent-preset.md)） | done | 原生记录的预设与所选一致；PTC 的工具过程展示经核对；旧对话不变 | 作者在 DSH 0.2.2-rc.1 真实 Host 上验证：标准、PTC 与草稿准备路径三种新建的原生 `agentPreset` 读回一致；PTC 任务的 `run_code` 及其子调用逐项显示；0.2.1-rc.4 兼容。同轮把 DSH 适配到 0.2.2（父会话跟随唤醒 Agent），并经运行中重启与 Plan/审核/审批回归 · [C11](../features/conversations.md#gotchas) | 2026-11-07 |
| [工作区文件阅读与编辑](workspace-file-reading-editing.md) | 查阅工作区文件，阅读 HTML 并跳转底稿，Agent 空闲时编辑并保存纯文本 | active | 桌面和手机走通阅读与返回，验证空闲保存及冲突保稿 | 见切片 PR | 2026-11-03 |
| 本轮文件 | 从对话轮末查看文件清单并打开工作区原文件 | done | 两个真实 Harness 的归轮、历史回看和文件打开通过独立验收 | [PR #19](https://github.com/Lanbasara/zhongshu/pull/19) · [对话验收 U11](../features/conversation-usability.md#u11-本轮文件) · [Storybook 交互入口](../features/interface.md#driving-it-with-harness) | 2026-11-03 |
| 通用文档附件 | 在图片之外上传常见文档交给 Agent，并能回看；图片归对话基本可用性 | next | 文档生命周期、真实原生输入、失败与清理验收 | none yet | 2026-11-02 |
| [会话生命周期与对话管理](workspace-conversation-management.md) | 按需导航与搜索，执行观察与释放，归档恢复和 Codex 完整删除 | active | 完整生命周期、两端真实路径、性能边界及独立浏览器验收见工作单 | 204 项自动化、两名独立 fixture/真实两端核心旅程通过；Codex 原生删除和重启读回、DSH 归档释放已核验 | 2026-11-06 |
| 实例级插件管理 | 在中书分别添加市场、发现和管理 Codex 与 DSH 插件 | done | 两端原生读回与界面一致，目标实例隔离与本地人工试用已验收 | [PR #20](https://github.com/Lanbasara/zhongshu/pull/20) · [插件管理地图](../features/plugin-management.md) | 2026-11-04 |
| 输入区技能引用与对话用量 | 用 `/` 查找并选用技能，查看当前对话的 Token 与上下文占用 | done | 两端原生技能调用与用量已独立核对，缺容量行为由 fixture 验证，DSH 测试实例已获用户验收 | [PR #21](https://github.com/Lanbasara/zhongshu/pull/21) · [U12 技能引用](../features/conversation-usability.md#u12-技能引用) · [U13 对话用量](../features/conversation-usability.md#u13-对话用量) | 2026-11-04 |
| 原生历史读取与存储边界 | 任意长度对话都能打开即最新、连续回溯到第一条，不因缺口卡死；存储有预算与清理入口 | done | 已实现并经用户手动验证；未做独立验收（用户决定）；退役正文表已由迁移 16 删除 | 本地 main `0e7a193` 及后续迁移提交；作者自测覆盖 fixture 与真实 Codex/DSH 的 H01–H05 · [ADR 0014](../adr/0014-native-history-source.md) · [continuity](../features/continuity.md) · [M09](../features/conversation-management.md#存储预算与清理) | 2026-11-06 |
| 同步瘦身 | 读取不再引起空转；运行中只推新增内容、逐帧不重读快照、不落盘（[ADR 0019](../adr/0019-live-deltas-and-pure-reads.md) 草案） | active | 测试实例上用真实 Harness 重测：推送量、快照重读与变更表写入显著下降，离开对话后任务结束不再空转；全部检查通过；用户确认 ADR 0019 | 2026-11-08 测试实例基线已测（Codex）；实现与重测进行中 | 2026-11-08 |
| 语音与安装后恢复 | 语音转文字、安装后恢复工作 | next | 分成独立小切片，各自有真实证据 | none yet | 2026-10-31 |

Ledger 状态只允许 `next / active / blocked / done`；spec front matter 使用 `draft / active / blocked / done`。`done` 行在一轮发布后删除；耐久知识已经折入 feature map / ADR。

## 文件


- [native-experience.md](native-experience.md) — 已授权实施；DSH 原生准备边界见 ADR 0011，待完成验收

- [draft-first-conversation.md](draft-first-conversation.md) — 范围、默认、标题与草稿规则已确认；实现与真实路径验证进行中

- [conversation-usability.md](conversation-usability.md) — 已授权实施；用户试用验收仍待完成
- [workspace-conversation-management.md](workspace-conversation-management.md) — 已授权实施，待完成验收
- [workspace-management.md](workspace-management.md) — 已授权实施，按工作单验收
- [workspace-file-reading-editing.md](workspace-file-reading-editing.md) — 真实 Harness 与浏览器已验证，手机真机待验收
- [integration-probes.md](integration-probes.md) — next
- [native-subagents.md](native-subagents.md) — 已实现（PR #37），独立验收通过；剩余未覆盖分支见工作单

## spec 模板

```markdown
---
status: draft
started: YYYY-MM-DD
exit: <一句可 pass/fail 的话>
evidence: <链接或 none yet>
---

# <切片名>

## Goal

## Users and stories

## Scope / Non-goals

## Implementation decisions

## Testing decisions

## Open questions
```

## 规则

- 一活跃切片一份 spec；不超过一页。
- spec 只记录用户确认的范围、验收和退出条件；Agent 不自行修改未被确认的内容。
- 不写易腐烂的文件路径和代码片段；需要时链接 feature map / architecture。
- ticket 放 GitHub Issues：垂直切片、blocked by、验收标准；spec 只维护切片级退出条件。
- 完成后：耐久知识折入 feature map / ADR；删除 spec；ledger 标 `done`。
- 不建“已完成计划”目录；git 历史就是档案。
