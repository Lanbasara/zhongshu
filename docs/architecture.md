# 架构：当前实现地图

本文只描述当前实现，随代码演进。长期取舍见 [ADR](adr/)，用户路径见 [feature maps](features/README.md)，共同验证方法见 [features/README](features/README.md)。按用户行为寻找修改与验证路径从 feature map 进入；本图维护模块职责与依赖。文档系统本身见 [ADR 0005](adr/0005-documentation-system.md)。

## 当前系统

当前实现单管理员私人工作台，通过 Codex 与 DSH 两个 adapter 创建对话、提交图文消息与引用、读取历史与状态、停止当前轮。Workbench 还持有运行中加入的消息队列，派发前将条目内容和发送方式冻结到操作记录。原生进程独立执行并提供接收与归属轮次的证据。公开的版本与健康接口不包含私有状态。

```text
React 浏览器 ──同源 HTTP / SSE──→ Fastify 应用
                                  ├─ 身份、来源与 CSRF 检查
                                  └─ Workbench ──→ SQLite
                                       ├─ Codex adapter ──→ App Server
                                       └─ DSH adapter ──→ Web Host

管理员终端 ──→ 初始化 / 重置 / 一致备份 / 恢复

源码 ──构建──→ dist ──打包──→ 镜像 ──外部发布流程──→ 运行实例
```

## 边界

| 边界 | 当前入口 | 设计理由 |
| --- | --- | --- |
| 页面与服务 | [React 页面](../src/web/main.tsx) / [HTTP 应用](../src/server/app.ts) | 同源接口，私有路由统一认证、来源与 CSRF 检查 |
| 身份 | [auth.ts](../src/server/auth.ts) / [管理员命令](../src/server/admin.ts) / [ADR 0006](adr/0006-auth-session-data.md) | 单管理员、服务端会话、私有数据目录边界 |
| 持久数据 | [database.ts](../src/server/database.ts) / [产品迁移](../src/server/migrations.ts) / [ADR 0003](adr/0003-local-persistence.md) | WAL/FULL、显式迁移、在线备份与新目录恢复；数据不在镜像内 |
| 对话与操作 | [Workbench](../src/server/workbench.ts) / [存储](../src/server/workbench-store.ts) | 派发前落库、未知回执核对、历史身份和原生生命周期统一管理 |
| 原生能力 | [共同语义](../src/harness/types.ts) / [Codex](../src/harness/codex/index.ts) / [DSH](../src/harness/dsh/index.ts) / [ADR 0001](adr/0001-native-harness-boundary.md) | 原生字段与版本差异留在各 adapter；不自行实现 Agent loop |
| 消息与资源 | [内容契约](../src/shared/content.ts) / [资源存储与路径](../src/server/resources.ts) / [正文](../src/web/conversation-content.tsx) / [输入](../src/web/composer.tsx) | 原生解释图片和工具，应用保存授权资源与消息元数据；前端不执行原始 HTML |
| 浏览器恢复 | [公开契约](../src/shared/workbench.ts) / [HTTP 与更新流](../src/server/workbench-http.ts) / [工作台](../src/web/workbench.tsx) / [ADR 0004](adr/0004-recoverable-communication.md) | 稳定操作编号、持久事件水位、有界慢端恢复和旧响应防覆盖 |
| 启动与配置 | [main.ts](../src/server/main.ts) / [config.ts](../src/server/config.ts) / [README](../README.md) | 先验证配置与迁移，再监听；HTTP 开发例外只允许回环 |
| 源码与产物 | [构建脚本](../scripts/build.mjs) / [Dockerfile](../Dockerfile) | 将版本信息嵌入产物，使运行结果能够关联源码提交 |
| 产品与运行环境 | [Compose](../compose.yaml) / [配置示例](../.env.example) | 可配置的运行契约支持不同部署目标，本地开发不需要生产凭据 |
| 产品与发布运维 | 通用镜像及自动化接口 | 源码交付可追溯产物；具体实例的发布、权限与运维知识由操作者在仓库之外维护 |

前后端由一个服务、一个镜像交付，SQLite 位于独立持久卷。框架与驱动的取舍分别归 ADR 0002/0003，身份与恢复操作归 ADR 0006，原生连接、执行限制与配置归 ADR 0001。默认镜像不包含或托管原生服务。

Codex adapter 在已建立连接丢失时报告内部 `unavailable` 事件，由 Workbench 立即持久化“待核实”并撤销配置/终态证明，保留绑定、历史、操作及最后已知运行信息。离线连接尝试失败不重复发失联事件；旧连接事件和旧代次读取不能覆盖后来的状态。重新连接后按原绑定核实配置和原生状态，不自动重发未知操作。公开 HTTP/SSE 仍使用既有状态契约。

Web manifest 提供独立窗口入口。界面以 Streamdown 渲染 Markdown/GFM/代码，用按轮折叠的工具组展示原生命令、输出和状态。运行中输入的路径见[执行功能地图](features/execution.md)。原始 HTML 不执行，链接协议受限。审批与提问仍由原生界面处理。

## 界面与设计系统

当前界面以安静、清晰、有质感为方向：导航紧凑，正文舒展，动作利落。设计参考保存在 [reference](../design/reference/index.html)，它记录已接受的原型，不参与产品运行。产品通过自己的布局与真实状态实现设计意图，引用、上传、执行与恢复沿用原有能力。

依赖从功能向展示单向流动：

| 层 | 当前职责与入口 | 扩展方法 |
| --- | --- | --- |
| 设计基础 | [tokens](../src/web/ui/tokens.ts) 是字体、字号角色、间距、颜色、圆角、层级、阴影与动效时序的作者源；[theme](../src/web/ui/theme.css) 由生成器输出，[motion](../src/web/ui/motion.ts) 使用同一时序 | 先找已有语义。新值在作者源定义并运行 tokens；构建拒绝未同步的 CSS |
| 基础组件 | [controls](../src/web/ui/controls.tsx) 和 [provider](../src/web/ui/provider.tsx)：按钮、图标按钮、菜单、提示、配置浮层及减少动效；Radix 负责焦点与键盘语义，Motion 负责状态过渡 | 不引用功能或展示模式；不请求服务、不持有对话或操作身份 |
| 展示模式 | [WorkbenchFrame](../src/web/patterns/workbench-frame.tsx) 管视口、分栏、导航抽屉；[ComposerView](../src/web/patterns/composer.tsx) 管输入增长、材料区、工具栏与状态呈现 | 通过 props 接受内容、能力、状态和回调。局部 hover/focus/展开是展示状态；发送/恢复结论由调用方给出 |
| 功能 | [workbench](../src/web/workbench.tsx)、[composer](../src/web/composer.tsx)、[transcript](../src/web/conversation-content.tsx)、工作区阅读/管理 | 拥有 API、真实业务状态、授权能力、草稿、上传与操作生命周期；向展示层传值，不把业务状态机搬进公共组件 |
| 开发工作台 | [.storybook](../.storybook/main.ts)、[stories](../design/stories/) | 复用产品组件展示状态。示例与模拟只存在开发入口，不成为产品默认值 |

界面字体用于控制与正文，宋体/衬线只用于阅读标题，等宽用于代码。颜色按 surface/text/action/status 等语义使用；工作区身份不改变主题，绿色只作为明确成功状态的一部分。输入与正文共用阅读宽度，导航和阅读器各自滚动；窄屏导航为有焦点约束的抽屉。响应、状态、表面切换分别使用 140/180/260ms 与同一缓动，系统减少动效时去除位移/持续旋转。

界面原型与组件示例的维护约定见 [ADR 0008](adr/0008-storybook-ui-prototypes.md)。启动命令见 [README](../README.md#ui-development)。

发布边界在 [design-boundaries](../scripts/design-boundaries.ts) 与 [check-release](../scripts/check-release.mjs)：源码 AST 拒绝产品到开发目录的依赖、展示层到功能的依赖与直接网络调用；Vite 检查实际模块图、输出名称和静态资源清单；最终 dist 记录文件及 SHA-256，容器校验清单且不得安装 Storybook。源码检查是防误用护栏，不是恶意源码沙箱。公共静态资源变化由 [product-assets](../scripts/product-assets.json) 显式登记，检查会识别改名混入的原型。构建与 Docker 的输入只含产品和必要构建工具，不含 reference/stories/Storybook 输出；验证反例见 [interface](features/interface.md)。

本次使用官方 npm 源固定 Radix UI 1.8.1、Motion 14.9.0；开发工作台使用 Storybook / React Vite 10.6.5，边界 AST 使用 Babel parser 8.1.0。准确依赖树由 lockfile 维护；新增依赖随版本变化重新审查。库负责通用交互机制，产品的视觉语义与组件契约由上述本地模块拥有。

## 消息与资源

共享 schema 约束图片元数据、工具字段与引用；旧文本条目缺少这些字段时仍可读取。原文件引用只保留工作区相对路径，选择、发送及派发校验当前文件；Agent 读取时使用原文件。消息选段保存来源条目与选中文字。Workbench 不重写原操作编号；恢复中的输入仍为同一提交。

图片字节作为 BLOB 与消息元数据同存 SQLite，沿用现有在线备份/恢复；不会新增个人路径或挂载。资源属于指定对话，读写均经过私有认证，写入另查来源/CSRF；公开契约只暴露资源 ID，不暴露原生路径。上传只接 PNG/JPEG/WebP，服务端核验魔数和字节：每张输入最多 2 MiB、每消息最多 4 张且合计 4 MiB；原生输出/工作区图片最多 6 MiB。库内图片总额上限 512 MiB，满额明确拒绝，不删历史腾空间。未关联上传在后续新资源写入时回收超过 7 天的项；pending 操作与历史关联的资源持续保留，移除不会删除已关联资源。

Codex 以原生 image input、DSH 以原生 image content 接图片，无需新增 Host 挂载。生成结果仅采集原生返回的图片字节或原生文件读取结果；失败显式显示。Markdown 工作区图片先验证消息来源、相对路径与非符号链接边界，再通过对应 Host 文件接口读取，按消息/来源保存首次可读快照；原文件之后移走仍能回看。它不是任意宿主文件代理。HTTPS 图片在浏览器直接请求并禁用 referrer；HTML、SVG 与可执行 URL 不通过本地资源通道。

输入草稿的文本/已上传资源/引用沿用 sessionStorage；失败或中断的上传文件单独在 IndexedDB 暂存，重新加载后需明确重试。发送前必须先持久化操作编号及原提交内容；上传未完成或暂存失败不会悄悄只发文本。退出清理浏览器草稿与暂存。两端文件读取与生成能力的具体差异留在 adapter，验证入口统一归 [对话基本可用性](features/conversation-usability.md)。

仅当已实现的变更影响本图应描述的模块职责、依赖、共享接口或数据归属时，更新受影响的条目。用户能力的入口、行为、实现定位和验收方法归对应的 [功能地图](features/README.md)。尚未实现的设计留在对应 spec 或 ADR 中。

## 工作区文件

阅读器以登记的工作区和相对路径定位原文件。私有工作台 API 提供目录、文件正文、可编辑状态和带版本的保存。正文不进入 SQLite。只读 HTML 在禁止脚本和网络资源的 iframe 内显示，由工作台解析同工作区底稿链接并恢复阅读位置。

Harness Adapter 提供可归因的编辑目标。工作台在写入历史或实时条目时记录对话、原生轮和工作区相对路径，转发当前历史页所涉及的清单。清单与文件内容分开读取，打开时仍走原工作区阅读器。

可写工作区由操作者声明写入边界。保存期间工作台阻止相交目录的新建与原生派发，并检查相关对话的原生状态和待处理请求。文件版本由内容和文件身份共同决定，只有旧版本匹配才替换。应用协调范围之外的写入者属于实例前提，详见[文件功能地图](features/workspace-files.md)。

DSH 原地保存要求专用 Host 和操作者提供的维护控制器。工作台协调暂停、写入和恢复，控制器负责证明进程树已退出并保留暂停状态。恢复后工作台重新核对原生状态与绑定，再开放派发。

## 工作区登记

操作者配置可登记的目录根和原生连接。工作区登记、显示名、置顶与移除状态由 SQLite 持久化。旧配置中的登记首次导入时沿用 ID，后续启动保留已保存的状态。工作台在文件访问和原生派发前核对登记和目录身份。移除期间检查关联对话的原生状态，停用登记与操作受理互斥。恢复沿用原登记，旧对话重新验证原生绑定后接续。操作入口和复验见[工作区管理](features/workspace-management.md)。


## 实例级插件管理

工作台私有路由和 SQLite 持有操作身份、回执和核实状态；安装、版本、启用状态以选定 Harness 的原生清单为准。每端一次只受理一个未决变更；请求丢失后按原操作 ID 读回，不自动重发。

Codex 经专用 Unix socket 管理进程调用固定 CLI 和同一实例的 App Server；管理进程核对连接身份、实例状态目录和操作者固定的 Git 市场。DSH 在该实例的 Web Host 上调用原生目录和包管理 API，并按市场核对包来源。中书管理员添加公开 GitHub 来源时，Codex 管理进程持有市场提交和身份，DSH Web Host 持有索引设置；来源变更与同端安装操作互斥。两个 Harness 保留各自的来源、标识和加载语义。页面与验证入口见[插件管理功能地图](features/plugin-management.md)。
