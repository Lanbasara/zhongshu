---
status: accepted
---

# 文档按读者与寿命分五类，并把可机械检查的事实交给 CI

## 背景

中书文档在开发中自然生长：架构、开发、Harness、身份、质量、验证各自成文，features 与 plans 同时承载现状、未来和验收状态。结果是：

- 读者和时态混在一起，Agent 无法判断哪份是当前事实；
- feature 页容易写成愿望或状态汇总，难以驱动验证；
- plan 完成后仍留在仓库，新的 Agent 分不清“已完成”和“下一步”；
- 文档链路没有机械保护，链接和路径会腐烂。

与此同时，Agent 会抄最近的例子，不会自动读一份“应该读”的规范。因此文档系统必须同时做到：入口可发现、事实单一、状态可计算、能机械检查的进 CI。

## 决策

采用五类文档 + 一个共享地图：

| 类型 | 位置 | 回答什么 | 时态 | 寿命 |
| --- | --- | --- | --- | --- |
| 宪法/路由 | `AGENTS.md`、`docs/README.md` | 边界、去哪读 | 恒常 | 极少改 |
| 领域语言 | `CONTEXT.md` | 与用户确认的词汇含义 | 恒常 | 慢 |
| 决策 | `docs/adr/` | 与用户确认的难逆转决定及取舍 | 过去 | 永久/被替代 |
| 约定/工作单 | `docs/spec/` | 与用户确认要建什么、范围与完成条件 | 未来 | 临时 |
| 功能地图 | `docs/features/` | 独立验证 Agent 怎么到达、驱动、证伪 | 现在 | 随行为变 |
| 共享地图 | `docs/architecture.md` | 现在代码在哪、依赖怎么走 | 现在 | 随代码变 |

产品仓库只记录产品真相；实例真相和证据真相在仓库外，由工作区 `AGENTS.md` 路由。产品文档不写某个人的 VPS、账号、试用状态或一次运行结果。

### 规则

1. 新文档三问：属于哪类？事实是否已有唯一归属？有没有明确更新触发？归不进去就不建；新增顶层文档需要 ADR。
2. 一个事实只有一个家；其他文档只链接，不复制。
3. ADR 只在“难逆转 + 反直觉 + 真取舍”三条同时成立时写；可以只有一段话。
4. feature map 只收已实现、可驱动、可证伪的用户能力；固定标题 `Sub-features`、`How to get to it (user POV)`、`Driving it with Harness`、`Gotchas`，可选 `Implementation and regression`；不写状态和未来。
5. spec 有 `status`、`exit`、`evidence`；完成后把耐久知识折入 feature map / ADR，删除 spec，ledger 标 done。
6. 证据不进入产品文档：版本、环境、观察、清理放在 PR/CI 或操作者实验记录中，文档只链接。
7. 能机械检查的事实进 `npm run check:docs`：链接、文件可达性、feature 标题、spec 字段、ADR 编号。
8. 产品文档使用中文，代码与注释使用英文。语言变更同样走 ADR。
9. `CONTEXT.md`、spec 和 ADR 只记录与用户讨论后确认的内容；Agent 可以提出草案，但不能把未确认的内容写成事实。
10. `AGENTS.md` 只指向稳定的类别入口，不枚举单个 ADR；具体决策由所属 architecture / feature / spec 链接。新增 ADR 不需要修改 `AGENTS.md`。

### 渐进式获取

```text
AGENTS.md → 类别索引（docs/README.md、features/README.md、spec/README.md）
          → 所属文档（architecture / feature map / spec）
          → 文档内链接的 ADR
```

任何一层都不维护全量 ADR 清单；新 ADR 只进入 `docs/adr/` 和所属文档。feature map 只服务独立验证 Agent，不承担需求或设计说明。

### 为什么不放在 `.agents/`

`.agents/` 不是 Codex/Claude 的通用文档加载目录；Codex 自动加载 `AGENTS.md`，Claude Code 自动加载 `CLAUDE.md`/`AGENTS.md`，两者都不读取 `.agents/` 下的任意文档。feature map 的可发现性来自 `AGENTS.md` 指针，不是目录名。`.agents/skills/` 是 Agent Skills 的约定，不应与普通文档混用。

## 依据

- **Matt Pocock**：按读者、寿命和问题分工；context pointer 的措辞决定是否触达；单一事实来源；持续修剪；ADR 三条件；spec 是对话的综合而非再访谈。
- **Dune**：最短路径即正确路径；能失败的约束才是约束；错误信息就是 prompt；验证是瓶颈；文档放在强制力阶梯最后。
- **pstack**：feature map 四段 + Gotchas；验证按 Launch/Doctor/Drive/Evidence/Cleanup；重复错误按“架构 → 类型/检查 → 行为测试 → 文档”沉淀；证据与规范分离。

这些只作为设计依据，不引入对应工具链；业务特定的禁令和流程不随之进入中书。

## 后果

- 文档数量减少，但每份的读者、时态和更新触发更明确。
- 迁移需要一次性的内容拆分；未映射的内容不删除。
- 文档事实开始受 CI 保护；语义判断仍由人和 Agent review。
- feature map 留在 `docs/features/`，接受它是“操作地图”而非产品说明书。

## 备选方案

- **保持现状**：读者与时态继续混合，plan 和 feature 继续漂移；不采用。
- **只保留 spec + ADR**：缺少当前能力的操作地图和验证路径；不采用。
- **把 feature map 放到 `.agents/features/`**：没有 harness 加载机制，反而制造“会自动加载”的错觉；不采用。
