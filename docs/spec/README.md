# 工作单索引

spec 是与用户讨论后确认的临时约定：它回答“接下来建什么、范围是什么、怎样算完成”。Agent 可以起草，但未确认的内容不能写成事实。当前事实在 [feature maps](../features/README.md)，长期取舍在 [ADR](../adr/)。状态只在这里维护。

## 当前切片

| 切片 | 用户行为 | 状态 | 退出条件 | 证据 | 更新 |
| --- | --- | --- | --- | --- | --- |
| [多年使用与极限规模](long-term-performance.md) | 长对话完整阅读、后台全量存档、大量工作区与文件持续可用 | active | 五个子规格在同一候选版本通过规模、故障与真实路径联合验收；全部在上线前完成 | none yet | 2026-11-04 |
| 主界面与设计系统 | 用统一设计完成真实对话，隔离展示公共组件 | done | 本轮实现及已声明验证范围经用户认可；未覆盖项见 PR | [PR #18](https://github.com/Lanbasara/zhongshu/pull/18) | 2026-11-03 |
| 首条 Agent 曳光弹 | 选 Codex 或 DSH，完成真实工作，关页后接续；必要时停止 | done | 本机两 Harness 完成真实工作、关页或应用中断后接续；目标设备与部署链路分别有证据 | PR #5、#6、#9；[发布检查](https://github.com/Lanbasara/zhongshu/actions/runs/41433423972)；目标设备与部署链路已由用户验收 | 2026-11-02 |
| [对话基本可用性](conversation-usability.md) | 读正文与工具过程、收发图片，用顺手的输入框引用消息与工作区原文件 | active | 两端真实用户路径与恢复验收，用户试用确认 | [PR #13](https://github.com/Lanbasara/zhongshu/pull/13) | 2026-11-02 |
| 会改变架构的接入实验 | 回答追加、文件保存、HTML 阅读等会改变实现的问题 | next | 每个问题有结论，决定进入 ADR | none yet | 2026-10-31 |
| [工作区管理](workspace-management.md) | 添加已有或新建的目录，改名、置顶、搜索、移除和恢复工作区 | active | 见工作单退出条件 | 见工作单 | 2026-11-03 |
| 运行中排队与追加输入 | 运行中排多条消息，逐条提前发送并核对归属轮次 | done | 两个真实 Harness 的队列、轮尾竞争和回执恢复通过独立执行 | [PR #19](https://github.com/Lanbasara/zhongshu/pull/19) · [执行地图](../features/execution.md#e06--e07-排队与提前发送) | 2026-11-03 |
| 回答提问与审批 | 处理 Harness 等待的用户回答或审批 | next | 两个 Harness 的原生语义分别接通并有真实证据 | none yet | 2026-10-31 |
| [工作区文件阅读与编辑](workspace-file-reading-editing.md) | 查阅工作区文件，阅读 HTML 并跳转底稿，Agent 空闲时编辑并保存纯文本 | active | 桌面和手机走通阅读与返回，验证空闲保存及冲突保稿 | 见切片 PR | 2026-11-03 |
| 本轮文件 | 从对话轮末查看文件清单并打开工作区原文件 | done | 两个真实 Harness 的归轮、历史回看和文件打开通过独立验收 | [PR #19](https://github.com/Lanbasara/zhongshu/pull/19) · [对话验收 U11](../features/conversation-usability.md#u11-本轮文件) · [Storybook 交互入口](../features/interface.md#driving-it-with-harness) | 2026-11-03 |
| 通用文档附件 | 在图片之外上传常见文档交给 Agent，并能回看；图片归对话基本可用性 | next | 文档生命周期、真实原生输入、失败与清理验收 | none yet | 2026-11-02 |
| [工作区与对话管理](workspace-conversation-management.md) | 按工作区组织、搜索、重命名、归档和恢复对话 | active | 桌面和手机用户路径、持久化与原生接续验收见工作单 | none yet | 2026-11-03 |
| 实例级插件管理 | 在中书分别添加市场、发现和管理 Codex 与 DSH 插件 | done | 两端原生读回与界面一致，目标实例隔离与本地人工试用已验收 | [PR #20](https://github.com/Lanbasara/zhongshu/pull/20) · [插件管理地图](../features/plugin-management.md) | 2026-11-04 |
| 输入区技能引用与对话用量 | 用 `/` 查找并选用技能，查看当前对话的 Token 与上下文占用 | done | 两端原生技能调用与用量已独立核对，缺容量行为由 fixture 验证，DSH 测试实例已获用户验收 | [PR #21](https://github.com/Lanbasara/zhongshu/pull/21) · [U12 技能引用](../features/conversation-usability.md#u12-技能引用) · [U13 对话用量](../features/conversation-usability.md#u13-对话用量) | 2026-11-04 |
| 语音与安装后恢复 | 语音转文字、安装后恢复工作 | next | 分成独立小切片，各自有真实证据 | none yet | 2026-10-31 |

Ledger 状态只允许 `next / active / blocked / done`；spec front matter 使用 `draft / active / blocked / done`。`done` 行在一轮发布后删除；耐久知识已经折入 feature map / ADR。

## 文件

- [long-term-performance.md](long-term-performance.md) — 本轮总范围与联合退出条件；[实施计划 #23](https://github.com/Lanbasara/zhongshu/issues/23)维护切片与依赖，已授权持续实现
- [managed-workspace-editing.md](managed-workspace-editing.md) — 受控执行入口与大规模工作区编辑
- [history-archival.md](history-archival.md) — 全量后台阅读存档与逐页恢复
- [bounded-conversation-reading.md](bounded-conversation-reading.md) — 有界预览、窗口与完整正文读取
- [storage-longevity.md](storage-longevity.md) — 累计容量、存储调度、迁移与恢复
- [workspace-directory-index.md](workspace-directory-index.md) — 大目录完整分页与工作区导航
- [conversation-usability.md](conversation-usability.md) — 已授权实施；用户试用验收仍待完成
- [workspace-conversation-management.md](workspace-conversation-management.md) — 已授权实施，待完成验收
- [workspace-management.md](workspace-management.md) — 已授权实施，按工作单验收
- [workspace-file-reading-editing.md](workspace-file-reading-editing.md) — 真实 Harness 与浏览器已验证，手机真机待验收
- [integration-probes.md](integration-probes.md) — next

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
