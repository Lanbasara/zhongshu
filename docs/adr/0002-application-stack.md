---
status: accepted
---

# React/Vite 工作台与常驻 Node 应用服务

采用 TypeScript、React + Vite 与同源交付，由 Node.js + Fastify 承担认证及 HTTP 接口；私人入口已迁移到该组合。原生执行边界见 [ADR 0001](0001-native-harness-boundary.md)，更新流仍须按相关切片验证。依赖版本固定于包清单及锁文件，升级验证不由框架支持声明代替。

## 服务端选择

Node.js 是服务端运行环境，Fastify 是运行其上的 HTTP 框架。认证和多条业务接口出现后，集中提供运行时校验、错误处理和请求生命周期比继续扩张手写 HTTP 路由更合适；TypeScript 类型不能替代边界校验。

仓库运行版本以 [.node-version](../../.node-version) 为准。2026-10-29 核对时，Node 24 已进入 Maintenance LTS，计划支持至 2028-04-30；建议先沿用已验证的 24 系列并及时更新补丁，再独立验证后续 LTS 升级。[Node 发布计划](https://github.com/nodejs/Release/blob/main/schedule.json)

Fastify 5 的维护政策覆盖支持期内的 Node LTS，其 `v5.12.7` CI 已包含 Node 24；这证明上游支持范围，不证明中书的插件组合与容器路径已通过。依赖在首次使用时锁定，升级复跑相关行为。[维护政策](https://fastify.dev/docs/latest/Reference/LTS/)、[固定版本 CI](https://github.com/fastify/fastify/blob/v5.12.7/.github/workflows/ci.yml)

稳定性主要取决于有界工作量、阻塞控制和失败恢复。CPU 密集处理及大文件扫描不占用 HTTP 事件循环；短数据库操作也要在流式负载下测量。资源上限、关闭/取消、进程恢复与诊断从相关能力首次交付时验收，按[质量要求](../quality.md)判断。[Node 事件循环说明](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)

## 为什么当前不加入 Next.js

Next.js 能为 SPA 提供自动代码拆分、路由预取、首屏 HTML，并提前在服务端取数以减少请求瀑布。这些收益与 SEO 无关，值得保留为替代方案；它也支持自托管。[SPA 指南](https://nextjs.org/docs/app/guides/single-page-applications)、[自托管指南](https://nextjs.org/docs/app/guides/self-hosting)

中书主要状态在首次加载后持续变化：流式回复、长历史、编辑草稿和后台切回。Next.js 的渲染与缓存机制仍需与客户端实时投影协调，也不负责原生任务的持久执行和操作恢复。因此当前选择 React/Vite 配合成熟路由、请求缓存及按需加载；在首个需要它们的切片确定具体库，不自行重造这些基础能力。[React 对独立 SPA 的取舍说明](https://react.dev/learn/build-a-react-app-from-scratch)

Vite 方案需要主动避免首屏请求瀑布、拆分编辑器/阅读器等大模块、设计数据预取；这些是本选择承担的工作，不能只拿裸 SPA 与完整 Next.js 比较。如果代表性样本中冷启动或导航持续达不到质量预算，先定位瓶颈，再以相同内容和网络比较 Next.js。若改选 Next.js，应重新划分 Web 服务职责，避免无理由同时保留两套同职能服务；Harness 生命周期始终独立于页面请求。
