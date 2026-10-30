# 文档入口

按当前任务进入一条阅读路径；这里不汇总所有正文。术语以 [CONTEXT](../CONTEXT.md) 为准，当前实现以代码及[架构地图](architecture.md)为准。

| 要解决的问题 | 入口与知识归属 |
| --- | --- |
| 如何运行、验证、提交修改 | [开发流程](development.md) |
| 当前有哪些用户能力，修改后如何自行验证 | [Feature map](features/README.md)，按用户路径进入实现、驱动与观察点 |
| 如何准备独立验证现场、保存证据和清理 | [通用验证能力](verification.md)，实例账号与本机路径由操作者在仓库外提供 |
| 初始化/重置管理员、保护会话、备份恢复数据 | [身份与数据操作](identity.md) |
| 连接原生服务、理解执行与恢复边界 | [Harness 接入与使用](harnesses.md) |
| 当前有哪些模块，去哪里修改 | [架构地图](architecture.md)，随实现更新代码入口 |
| 为什么这样划分应用与 Agent | [ADR 0001：原生 Harness 边界](adr/0001-native-harness-boundary.md) |
| React/Vite、服务端和 Next.js 如何取舍 | [ADR 0002：应用技术结构](adr/0002-application-stack.md) |
| 哪些状态放 SQLite，如何选择驱动 | [ADR 0003：持久化归属](adr/0003-local-persistence.md) |
| 操作、历史与断线恢复如何成立 | [ADR 0004：可恢复通信](adr/0004-recoverable-communication.md) |
| 网络、访问体验、性能要达到什么程度 | [质量要求](quality.md) |
| 接下来开发什么，哪些问题需先验证 | [交付路线](plans/README.md)，仅下一切片保留详细计划 |

ADR 记录有实质取舍的决定及必要依据；`accepted` 表示决定已确认，`proposed` 表示仍待验证或讨论，两者都不表示代码已经实现。证据就近链接在相关决定中；单次研究过程、测量输出和截图归任务、PR 或 CI。

修改知识时更新其唯一归属，其他入口只保留链接。计划完成后，将模块入口归入架构地图、用户路径归入 feature-map、共用操作归入开发/验证文档，完成证据留在 PR，删去已失效的计划。个人部署资料由操作者在源码之外维护。
