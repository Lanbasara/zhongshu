# 文档入口

本仓库的文档系统由 [ADR 0005](adr/0005-documentation-system.md) 定义。按任务进入；这里只做索引，不复制正文。

| 文档 | 类型 | 回答什么 | 更新触发 |
| --- | --- | --- | --- |
| [AGENTS.md](../AGENTS.md) | 宪法/路由 | 边界、任务路由、完成定义 | 边界或入口变化 |
| [CONTEXT.md](../CONTEXT.md) | 领域语言 | 术语含义 | 术语变化 |
| [architecture.md](architecture.md) | 共享地图 | 当前模块、依赖、数据归属 | 职责、依赖或接口变化 |
| [adr/](adr/) | 决策 | 为什么做难逆转的决定 | 新决定 |
| [spec/README.md](spec/README.md) | 工作单索引 | 当前切片、状态、退出条件 | 切片开始或完成 |
| [features/README.md](features/README.md) | 功能地图索引 | 现有能力、驱动、共同验证 | 能力或入口变化 |

## 规则

- 先归类，再新建；新文档三问见 ADR 0005。
- 一个事实只有一个家；其他文档链接。
- spec 完成后折入 feature map / ADR 并删除。
- 能机械检查的事实进 `npm run check:docs`。

## 维护

每个切片结束时：把耐久知识折入 feature map / ADR；spec 标 `done` 后删除；ledger 更新；运行 `npm run check:docs`。发现同类错误反复出现时，优先改进结构或检查，而不是再加一段文档。
