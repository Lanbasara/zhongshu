# 工作单索引

spec 是临时工作单：它回答“接下来建什么、怎样算完成”。当前事实在 [feature maps](../features/README.md)，长期取舍在 [ADR](../adr/)。状态只在这里维护。

## 当前切片

| 切片 | 用户行为 | 状态 | 退出条件 | 证据 | 更新 |
| --- | --- | --- | --- | --- | --- |
| 首条 Agent 曳光弹 | 选 Codex 或 DSH，完成真实工作，关页后接续；必要时停止 | active | 本机两 Harness 完成真实工作、关页或应用中断后接续；目标设备与部署链路分别有证据 | PR #5、#6、CI；目标环境未验收 | 2026-10-31 |
| 会改变架构的接入实验 | 回答追加、文件保存、HTML 阅读等会改变实现的问题 | next | 每个问题有结论，决定进入 ADR | none yet | 2026-10-31 |
| 多工作区 | 在多个自选工作区开展工作 | next | 页面可选择已登记目录并完成一轮真实工作 | none yet | 2026-10-31 |
| 运行中追加与审批 | 执行中追加、回答问题或审批 | next | 两个 Harness 的原生语义分别接通并有真实证据 | none yet | 2026-10-31 |
| 文件阅读与编辑 | 打开成果、跳转底稿、编辑 Markdown/TXT 并保存 | next | 阅读、编辑、冲突检测与保存路径验收 | none yet | 2026-10-31 |
| 附件 | 上传图片或常见文档交给 Agent，并能回看 | next | 上传生命周期、真实原生输入、失败与清理验收 | none yet | 2026-10-31 |
| 搜索与语音 | 搜索对话、语音转文字、安装后恢复工作 | next | 分成独立小切片，各自有真实证据 | none yet | 2026-10-31 |

Ledger 状态只允许 `next / active / blocked / done`；spec front matter 使用 `draft / active / blocked / done`。`done` 行在一轮发布后删除；耐久知识已经折入 feature map / ADR。

## 文件

- [first-harness-tracer.md](first-harness-tracer.md) — active
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
- 不写易腐烂的文件路径和代码片段；需要时链接 feature map / architecture。
- ticket 放 GitHub Issues：垂直切片、blocked by、验收标准；spec 只维护切片级退出条件。
- 完成后：耐久知识折入 feature map / ADR；删除 spec；ledger 标 `done`。
- 不建“已完成计划”目录；git 历史就是档案。
