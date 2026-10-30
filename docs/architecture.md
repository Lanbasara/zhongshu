# 架构：当前实现地图

本文只描述当前实现，随代码演进。长期取舍、候选方案和下一切片从[文档入口](README.md)按任务读取；ADR 已确认不等于已实现。

按用户行为寻找修改与真实验证路径，从 [feature-map](features/README.md)进入；本图维护模块职责与依赖。

## 当前系统

当前实现单管理员私人工作台，通过 Codex 与 DSH 两个 adapter 创建对话、提交文本、读取历史与状态、停止当前轮。应用保留操作记录和展示历史，原生进程独立执行。公开的版本与健康接口不包含私有状态。

```text
React 浏览器 ──同源 HTTP / SSE──→ Fastify 应用
                                  ├─ 身份、来源与 CSRF 检查
                                  └─ Workbench ──→ SQLite
                                       ├─ Codex adapter ──→ App Server
                                       └─ DSH adapter ──→ Web Host

管理员终端 ──→ 初始化 / 重置 / 一致备份 / 恢复

源码 ──构建──→ dist ──打包──→ 镜像 ──外部发布流程──→ 运行实例
```

| 边界 | 当前入口 | 设计理由 |
|---|---|---|
| 页面与服务 | [React 页面](../src/web/main.tsx) / [HTTP 应用](../src/server/app.ts) | 同源接口，私有路由统一认证、来源与 CSRF 检查 |
| 身份 | [auth.ts](../src/server/auth.ts) / [管理员命令](../src/server/admin.ts) | 随机服务端会话、持久限速；初始化/重置只在可信终端提供 |
| 持久数据 | [database.ts](../src/server/database.ts) / [产品迁移](../src/server/migrations.ts) | WAL/FULL、显式迁移、在线备份与新目录恢复；数据不在镜像内 |
| 对话与操作 | [Workbench](../src/server/workbench.ts) / [存储](../src/server/workbench-store.ts) | 派发前落库、未知回执核对、历史身份和原生生命周期统一管理 |
| 原生能力 | [共同语义](../src/harness/types.ts) / [Codex](../src/harness/codex/index.ts) / [DSH](../src/harness/dsh/index.ts) | 原生字段与版本差异留在各 adapter；不自行实现 Agent loop |
| 浏览器恢复 | [公开契约](../src/shared/workbench.ts) / [HTTP 与更新流](../src/server/workbench-http.ts) / [工作台](../src/web/workbench.tsx) | 稳定操作编号、持久事件水位、有界慢端恢复和旧响应防覆盖 |
| 启动与配置 | [main.ts](../src/server/main.ts) / [config.ts](../src/server/config.ts) | 先验证配置与迁移，再监听；HTTP 开发例外只允许回环 |
| 源码与产物 | [构建脚本](../scripts/build.mjs) / [Dockerfile](../Dockerfile) | 将版本信息嵌入产物，使运行结果能够关联源码提交 |
| 产品与运行环境 | [Compose](../compose.yaml) / [配置示例](../.env.example) | 可配置的运行契约支持不同部署目标，本地开发不需要生产凭据 |
| 产品与发布运维 | 通用镜像及自动化接口 | 源码交付可追溯产物；具体实例的发布、权限与运维知识由操作者在仓库之外维护 |

前后端由一个服务、一个镜像交付，SQLite 位于独立持久卷。框架与驱动的取舍分别归 ADR 0002/0003，账号与恢复操作归[身份说明](identity.md)，原生连接、执行限制与配置归 [Harness 接入](harnesses.md)。默认镜像不包含或托管原生服务。

Web manifest 提供独立窗口入口；离线缓存、运行中追加、审批/提问界面、成果阅读器与编辑器尚未实现。原生等待不会被静默批准。界面使用文本正文与折叠工具活动，HTML 原型仅指导交互意图。

新增能力时，在本图补上实际调用边界及实现入口；模块接口包括失败、顺序和副作用。尚未实现的模块留在对应 ADR 或切片计划中，避免把目标图误读成现有结构。
