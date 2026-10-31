# 中书工作合同

让没有聊天历史的 Agent 也能找到入口、理解边界、完成有界修改，并给出可信结果。

## 这个仓库是什么

中书是可自托管的个人 Agent 工作台。React 前端与 Fastify 应用提供单管理员私人入口，SQLite 保存状态；Codex App Server 与 DSH Web Host 作为独立原生 Harness 提供执行。产品源码必须可移植：任何克隆都不依赖某个人的机器、部署或凭据。

## 硬边界

- 产品源码与实例解耦。仓库只放通用代码、接口、示例和产品文档；真实目标、凭据、个人运维记录与运行数据在仓库外。
- 私有数据与执行能力必须有服务端认证、授权和明确权限边界。
- 完成声明必须与实际证据一致，区分已实现、已验证、未验证和受阻。既有检查通过只证明其覆盖范围。
- 开发通过分支向 `main` 提交 PR；合并是代码集成，不是生产发布。

## 文档系统

五类文档 + 一个共享地图。定义见 [ADR 0005](docs/adr/0005-documentation-system.md)。

| 类型 | 位置 | 回答什么 | 生命周期 |
| --- | --- | --- | --- |
| 宪法/路由 | `AGENTS.md`、`docs/README.md` | 边界、去哪读 | 长期稳定，极少改 |
| 领域语言 | `CONTEXT.md` | 与用户确认的词汇含义 | 长期，随确认更新 |
| 决策 | `docs/adr/` | 与用户确认的难逆转决定及取舍 | 永久保留，可被替代 |
| 约定/工作单 | `docs/spec/` | 与用户确认的范围与完成条件 | 临时，完成后删除 |
| 功能地图 | `docs/features/` | 独立验证 Agent 怎么到达、驱动、证伪 | 随当前行为更新 |
| 共享地图 | `docs/architecture.md` | 当前模块、依赖、数据归属 | 随代码更新 |

新建文档前先问：属于哪类？这个事实是否已有唯一归属？有没有明确更新触发？归不进去就不建；新增顶层文档需要 ADR。同一事实只写一处，其他位置链接。

涉及需求、范围、术语或不可逆取舍时，先与用户讨论。`CONTEXT.md`、`spec`、`ADR` 只记录已经确认的内容；Agent 可以提出草案，但不能把未确认的内容写成事实。`docs/features/` 是给独立验证 Agent 使用的当前行为地图，不是需求或设计文档。

## 按任务读取

本表只指向稳定的类别入口；具体 ADR 由所属文档链接。新增 ADR 不需要修改本表。

| 任务 | 先读 |
| --- | --- |
| 改一个用户能力 | [docs/features/README.md](docs/features/README.md) → 对应能力页 |
| 做新需求 | 先与用户确认范围/术语；再读 [docs/spec/README.md](docs/spec/README.md) → 当前 spec |
| 改架构、边界或数据归属 | [docs/architecture.md](docs/architecture.md) → 该边界链接的决策 |
| 改认证、会话或数据操作 | [docs/features/access.md](docs/features/access.md) |
| 改 Harness 接入、发送、停止或恢复 | [docs/features/execution.md](docs/features/execution.md)（创建/接续见 [conversations](docs/features/conversations.md) / [continuity](docs/features/continuity.md)） |
| 运行、构建、提交 | [README](README.md) |
| 写文档或改文档系统 | 本文档系统节 + [docs/README.md](docs/README.md) |
| 发布或实例运维 | 本仓库之外的操作者入口 |

## 完成的定义

一项改动完成，至少满足：

1. `npm run typecheck`、`npm test`、`npm run build`、`npm run check:docs` 通过；
2. 受影响的用户路径有真实运行证据；不能只凭模型自述或 HTTP 200；
3. 相关 feature map 已更新；spec / ADR 的变更已与用户确认，或明确说明无需更新；
4. 未运行、受阻和未覆盖的部分写清楚，不把“尚未验证”写成“通过”。

## 判断空间

在已确定的目标和边界内，自主选择实现、分工和验证方法。需要改变目标、公开契约或已约定边界时，带具体影响和取舍重新对齐。以小而完整的曳光弹推进；让正确路径容易发现；验证强度匹配复杂度与风险。

## 改规则的规则

文档系统本身由 ADR 0005 定义。改变五类、新增顶层文档、放宽检查，必须写一份新 ADR 并说明影响；不能在功能 PR 里顺手改。GitHub 仓库、PR、issue、分支、workflow 和检查优先使用已认证的 `gh` CLI。
