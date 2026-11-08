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
| 持久数据 | [database.ts](../src/server/database.ts) / [产品迁移](../src/server/migrations.ts) / [存储预算](../src/server/storage.ts) / [ADR 0003](adr/0003-local-persistence.md) | WAL/FULL、显式迁移、在线备份与新目录恢复；数据不在镜像内；不保存历史正文，实例预算约束库大小 |
| 对话与操作 | [Workbench](../src/server/workbench.ts) / [存储](../src/server/workbench-store.ts) | 派发前落库、未知回执核对和原生生命周期统一管理；历史正文按需从原生读取（[ADR 0014](adr/0014-native-history-source.md)） |
| 原生能力 | [共同语义](../src/harness/types.ts) / [Codex](../src/harness/codex/index.ts) / [DSH](../src/harness/dsh/index.ts) / [ADR 0001](adr/0001-native-harness-boundary.md) | 原生字段与版本差异留在各 adapter；不自行实现 Agent loop |
| 消息与资源 | [内容契约](../src/shared/content.ts) / [资源存储与路径](../src/server/resources.ts) / [正文](../src/web/conversation-content.tsx) / [输入](../src/web/composer.tsx) | 原生解释图片和工具，应用保存授权资源与消息元数据；前端不执行原始 HTML |
| 浏览器恢复 | [公开契约](../src/shared/workbench.ts) / [HTTP 与更新流](../src/server/workbench-http.ts) / [工作台](../src/web/workbench.tsx) / [历史窗口](../src/web/history-window.ts) / [ADR 0004](adr/0004-recoverable-communication.md) | 稳定操作编号、持久事件水位、有界慢端恢复和旧响应防覆盖；按原生页组成有界窗口，两端可读回 |
| 启动与配置 | [main.ts](../src/server/main.ts) / [config.ts](../src/server/config.ts) / [README](../README.md) | 先验证配置与迁移，再监听；HTTP 开发例外只允许回环 |
| 源码与产物 | [构建脚本](../scripts/build.mjs) / [Dockerfile](../Dockerfile) | 将版本信息嵌入产物，使运行结果能够关联源码提交 |
| 产品与运行环境 | [Compose](../compose.yaml) / [配置示例](../.env.example) | 可配置的运行契约支持不同部署目标，本地开发不需要生产凭据 |
| 产品与发布运维 | 通用镜像及自动化接口 | 源码交付可追溯产物；具体实例的发布、权限与运维知识由操作者在仓库之外维护 |

前后端由一个服务、一个镜像交付，SQLite 位于独立持久卷。框架与驱动的取舍分别归 ADR 0002/0003，身份与恢复操作归 ADR 0006，原生连接、执行限制与配置归 ADR 0001。默认镜像不包含或托管原生服务。

Codex adapter 在已建立连接丢失时报告内部 `unavailable` 事件，由 Workbench 立即持久化“待核实”并撤销配置/终态证明，保留绑定、历史、操作及最后已知运行信息。离线连接尝试失败不重复发失联事件；旧连接事件和旧代次读取不能覆盖后来的状态。重新连接后按原绑定核实配置和原生状态，不自动重发未知操作。公开 HTTP/SSE 仍使用既有状态契约。

Web manifest 提供独立窗口入口，推送与安装见下方[通知与安装](#通知与安装)。界面以 Streamdown 渲染 Markdown/GFM/代码，用按轮折叠的工具组展示原生命令、输出和状态。运行中输入的路径见[执行功能地图](features/execution.md)。原始 HTML 不执行，链接协议受限。Agent 的提问与审批见下方[提问与审批](#提问与审批)。

## 新建草稿与配置归属

[new-conversation.tsx](../src/web/new-conversation.tsx) 管理每工作区草稿和首次发送：生成稳定对话/操作编号，创建、等待准备、上传并派发，失败后沿原编号核对。它通过 [new-conversation-state.ts](../src/web/new-conversation-state.ts) 在 sessionStorage 保留文字、材料引用、配置及首发状态，未上传图片在 IndexedDB；[conversation-preferences.ts](../src/web/conversation-preferences.ts) 的 localStorage 只记配置偏好，不存消息正文。首次发送前不创建正式产品对话；DSH 可提前准备原生空会话，Codex 不提前创建；零工作区入口引导登记。长期决定见 [ADR 0010](adr/0010-draft-first-conversation.md) 与 [ADR 0011](adr/0011-dsh-prepared-session.md)，复验入口见 [创建对话](features/conversations.md)。

DSH 对话的 Agent 预设（标准或 PTC）是固定配置的一部分（[ADR 0017](adr/0017-dsh-agent-preset.md)）：模型目录给出可选预设与中书自己的默认（标准）；Workbench 只接受目录中可用的预设，Store 把它纳入创建身份（仅在选择时，旧对话的身份不变）；DSH 在新建或首发占用准备时设定，并以原生投影核对。

配置偏好失效或缺失时，私有 `/conversation-defaults` 从既有 accepted message 操作找最近成功发送的可用工作区/对话，不另建服务端偏好数据。历史 DSH 编码配置仅在新草稿默认响应中拆分 model/effort，不改旧绑定。模型目录提供真实支持的 reasoningEfforts 和可靠默认；Workbench 准备阶段校验，Store 将可选 reasoningEffort 纳入不可变配置及重试身份。已有对话不允许通过新建配置组件重配。

私有 `/draft-files` 按登记工作区边界列文件；`/draft-skills` 仅在 adapter 有创建前能力时读取。Codex 按 cwd 读取并在提交时核对技能身份；DSH 通过带认证与 CSRF 的 `POST /draft-preparation` 准备并读取技能。Workbench/Store 持久化每工作区一份未占用准备；浏览器持有与原生身份不同的 preparationId，首发原子占用并沿原生身份配置和派发。已占用身份不能被另一草稿复用，未知准备保留核对；重复进入不会不断增加空会话。

## 界面与设计系统

当前界面方向为“精密工具”（用户于 2026-11-07 在桌面与手机原型中逐项确认，[PR #38](https://github.com/Lanbasara/zhongshu/pull/38)）：冷白底、高对比、紧凑，单一靛蓝强调色，彩色状态点，细边框，快速利落的动效。信息结构以工作区树为主导航：侧栏只放新对话、搜索与跳转、工作区树和底部的工作区文件/已归档/设置；插件、工作区管理、存储和账户都在设置页。阅读器和子 Agent 面板按需从右侧滑出，不常驻占列。品牌标识为竖条（与 [icon](../src/web/public/icon.svg) 同一图形）。设计取值与组件状态在 Storybook 组件目录中展示，产品不依赖任何原型文件。

依赖从功能向展示单向流动：

| 层 | 当前职责与入口 | 扩展方法 |
| --- | --- | --- |
| 设计基础 | [tokens](../src/web/ui/tokens.ts) 是字体、字号角色、间距、颜色、圆角、层级、阴影与动效时序的作者源；[theme](../src/web/ui/theme.css) 由生成器输出，[motion](../src/web/ui/motion.ts) 使用同一时序 | 先找已有语义。新值在作者源定义并运行 tokens；构建拒绝未同步的 CSS |
| 基础组件 | [controls](../src/web/ui/controls.tsx) 和 [provider](../src/web/ui/provider.tsx)：按钮、图标按钮、菜单、提示、配置浮层及减少动效；Radix 负责焦点与键盘语义，Motion 负责状态过渡 | 不引用功能或展示模式；不请求服务、不持有对话或操作身份 |
| 展示模式 | [WorkbenchFrame](../src/web/patterns/workbench-frame.tsx) 管视口、侧栏、手机抽屉与右侧面板；[sidebar](../src/web/patterns/sidebar.tsx) 管侧栏结构与对话行；[command-palette](../src/web/patterns/command-palette.tsx) 管搜索与跳转；[process](../src/web/patterns/process.tsx) 管 Agent 过程的展开与收起；[ComposerView](../src/web/patterns/composer.tsx) 管输入增长、材料区、工具栏与状态呈现 | 通过 props 接受内容、能力、状态和回调。局部 hover/focus/展开是展示状态；发送/恢复结论由调用方给出 |
| 功能 | [workbench](../src/web/workbench.tsx)、[composer](../src/web/composer.tsx)、[transcript](../src/web/conversation-content.tsx)、[search](../src/web/workbench-search.tsx)、[settings](../src/web/settings-view.tsx)、[archive](../src/web/archive-view.tsx)、工作区阅读/管理；对话状态到状态点的映射只在 [conversation-status](../src/web/conversation-status.ts) | 拥有 API、真实业务状态、授权能力、草稿、上传与操作生命周期；向展示层传值，不把业务状态机搬进公共组件 |
| 开发工作台 | [.storybook](../.storybook/main.ts)、[stories](../design/stories/) | 复用产品组件展示状态。示例与模拟只存在开发入口，不成为产品默认值 |

标题、控制与正文统一使用界面字体（长文正文 15px），等宽只用于代码与命令。组件只用语义颜色（surface/text/accent/status 等），以后加入暗色只需重定义语义层。状态各有一种形状与颜色：运行中为蓝色转圈，完成未读为绿点，执行失败为红点，等待处理为琥珀点，待核实与已中断分别为橙色、灰色空心圈，就绪不显示。输入与正文共用阅读宽度；窄屏为抽屉导航，标题栏提供搜索，浮层改为底部面板或全屏。响应、状态、表面切换分别使用 120/180/260ms 与同一缓动，系统减少动效时去除位移、持续旋转与流光。

界面原型与组件示例的维护约定见 [ADR 0008](adr/0008-storybook-ui-prototypes.md)。启动命令见 [README](../README.md#ui-development)。

发布边界在 [design-boundaries](../scripts/design-boundaries.ts) 与 [check-release](../scripts/check-release.mjs)：源码 AST 拒绝产品到开发目录的依赖、展示层到功能的依赖与直接网络调用；Vite 检查实际模块图、输出名称和静态资源清单；最终 dist 记录文件及 SHA-256，容器校验清单且不得安装 Storybook。源码检查是防误用护栏，不是恶意源码沙箱。公共静态资源变化由 [product-assets](../scripts/product-assets.json) 显式登记，检查会识别改名混入的原型。构建与 Docker 的输入只含产品和必要构建工具，不含 stories/Storybook 输出；验证反例见 [interface](features/interface.md)。

本次使用官方 npm 源固定 Radix UI 1.8.1、Motion 14.9.0；开发工作台使用 Storybook / React Vite 10.6.5，边界 AST 使用 Babel parser 8.1.0。准确依赖树由 lockfile 维护；新增依赖随版本变化重新审查。库负责通用交互机制，产品的视觉语义与组件契约由上述本地模块拥有。

## 消息与资源

共享 schema 约束图片元数据、工具字段与引用；旧文本条目缺少这些字段时仍可读取。原文件引用只保留工作区相对路径，选择、发送及派发校验当前文件；Agent 读取时使用原文件。消息选段保存来源条目与选中文字。Workbench 不重写原操作编号；恢复中的输入仍为同一提交。

图片字节作为 BLOB 存在 SQLite，沿用现有在线备份/恢复；不会新增个人路径或挂载。资源属于指定对话，读写均经过私有认证，写入另查来源/CSRF；公开契约只暴露资源 ID，不暴露原生路径。上传只接 PNG/JPEG/WebP，服务端核验魔数和字节：每张输入最多 2 MiB、每消息最多 4 张且合计 4 MiB；原生输出/工作区图片最多 6 MiB。图片计入下文的实例存储预算：上传在预算满时被拒绝；原生图片副本以 `native:` 引用标记，可淘汰、需要时从原生重新取回；工作区图片的首次可读快照与上传一样不被自动淘汰。未关联上传在后续新资源写入时回收超过 7 天的项；pending 操作与历史关联的资源持续保留，移除不会删除已关联资源。

Codex 以原生 image input、DSH 以原生 image content 接图片，无需新增 Host 挂载。生成结果仅采集原生返回的图片字节或原生文件读取结果；失败显式显示。Markdown 工作区图片先验证消息来源、相对路径与非符号链接边界，再通过对应 Host 文件接口读取，按消息/来源保存首次可读快照；原文件之后移走仍能回看。它不是任意宿主文件代理。HTTPS 图片在浏览器直接请求并禁用 referrer；HTML、SVG 与可执行 URL 不通过本地资源通道。

输入草稿的文本/已上传资源/引用沿用 sessionStorage；失败或中断的上传文件单独在 IndexedDB 暂存，重新加载后需明确重试。发送前必须先持久化操作编号及原提交内容；上传未完成或暂存失败不会悄悄只发文本。退出清理浏览器草稿与暂存。两端文件读取与生成能力的具体差异留在 adapter，验证入口统一归 [对话基本可用性](features/conversation-usability.md)。

已有对话的技能目录从其绑定 Harness 读取；创建前能力见上方新建草稿边界。私有接口给浏览器显示信息和不透明 ID，草稿与操作保存已选技能的 ID 及文本位置。派发时 adapter 按原生清单核对并转换为本端输入。用量由 adapter 从原生事件或当前投影读取，Workbench 保存每段对话最近一次已确认的用量快照，通过原有变更流提示页面重取。复验见[技能引用](features/conversation-usability.md#u12-技能引用)与[对话用量](features/conversation-usability.md#u13-对话用量)。

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

Codex 经专用 Unix socket 管理进程调用固定 CLI 和同一实例的 App Server；管理进程核对连接身份、实例状态目录和操作者固定的 Git 市场。DSH 在该实例的 Web Host 上调用原生目录和包管理 API，并按市场核对包来源。中书管理员添加公开 GitHub 来源时，Codex 管理进程持有市场提交和身份，DSH Web Host 持有索引设置；来源变更与同端安装操作互斥。两个 Harness 保留各自的来源、标识和加载语义。长期取舍见 [ADR 0009](adr/0009-instance-plugin-scope.md)，原生连接配置和复验入口见[插件管理功能地图](features/plugin-management.md)。

## 原生子 Agent

边界依据 [ADR 0013](adr/0013-native-subagent-observation.md)：子 Agent 由 Harness 派生和执行，中书只观察并可停止单个子 Agent，不派生、不分配、不发消息。

| 层 | 当前职责 |
| --- | --- |
| 接入 | [共同语义](../src/harness/types.ts) 增加子 Agent 列表、过程读取、观察与停止。[Codex](../src/harness/codex/index.ts) 用 `thread/list` 的后代查询（含已归档分区）发现子 thread，沿 `parentThreadId` 核实归属，把带子 thread 身份的通知转成所属对话的提示，用 `turn/interrupt` 停止；子 thread 不被中书解除订阅。[DSH](../src/harness/dsh/index.ts) 从父会话快照读取 `subagentCatalog` 与 `agentTeam`，按 subagent 地址被动跟随子会话取状态和过程，用 `subagents/interruptByParent` 停止。两端把原生协作记录映射为带 `collaboration` 的条目 |
| 服务 | [Workbench](../src/server/workbench.ts) 合并提示后读取原生子 Agent 树；子 Agent 运行、待核实或停止未决时计入执行责任，归档和删除前要求子树已结束。观察丢失时撤销核实。停止是带稳定编号的操作，未知回执只按核实读取结算，不重发 |
| 数据 | [子 Agent 存储](../src/server/subagent-store.ts) 在对话行保存子 Agent 索引（身份、父子、显示信息、最后核实状态、每个子 Agent 的修订号）和停止操作表；子 Agent 过程只向原生现读，不入库 |
| 接口 | 私有路由提供列表、过程分页、阅读租约、停止及停止结果核对；对话视图带子 Agent 摘要，变更流以摘要修订号提示页面重读 |
| 界面 | [展示组件](../src/web/patterns/subagents.tsx) 只接收数据；[功能层](../src/web/subagents.tsx) 管理请求、租约与停止，[工作台](../src/web/workbench.tsx) 放置头部入口、阅读区面板（窄屏整页）、正文协作卡片和提示，[侧栏](../src/web/conversation-navigation.tsx) 显示后台运行标记 |

## 提问与审批

边界依据 [ADR 0016](adr/0016-questions-and-approvals.md)：请求由原生 Harness 持有，中书展示并递送一次回答；审批策略随权限在新建时固定。

| 层 | 当前职责 |
| --- | --- |
| 接入 | [共同语义](../src/harness/types.ts) 增加 `requests` / `answer` 与 `requests` 变更提示。[Codex](../src/harness/codex/index.ts) 经 [RPC](../src/harness/codex/rpc.ts) 接住 App Server 发来的命令、文件、权限审批与 MCP 信息请求（[映射](../src/harness/codex/requests.ts)），在收到它的连接上回答，以 `serverRequest/resolved` 为送达确认；断线时清空，重新接入对话及运行中的子 Agent 时由原生重发。[DSH](../src/harness/dsh/index.ts) 以应答身份连接，[连接](../src/harness/dsh/connection.ts) 另开事件流接收转发的提问与审批（[映射](../src/harness/dsh/requests.ts)），按事件编号回答，绝不回复“交给下一个”。无法呈现的请求明确拒绝并在对话中说明 |
| 服务 | [Workbench](../src/server/workbench.ts) 在内存中保持每段对话的请求视图（打开、已回答、已失效，已结束的保留约 10 分钟），观察丢失时不判失效。回答是带稳定编号的操作：校验与请求相符后入库、派发、按回执结算；回执未知只靠重新读取原生判断，原生仍在等待则作废该回答以便重答 |
| 数据 | [回答存储](../src/server/request-store.ts)（迁移 18）保存回答编号、所属对话与请求、状态与摘要；提交的内容在结算后清除。请求本身不入库 |
| 接口 | 快照带 `requests`；私有 `POST /conversations/:id/requests/:request/answer` 与 `/request-answers/:answer/reconcile`，沿用认证、来源与 CSRF 检查，日志不含内容 |
| 界面 | [展示组件](../src/web/patterns/requests.tsx) 只接收数据（文案与服务端摘要由测试保持一致）；[功能层](../src/web/requests.tsx) 提交与核对，放在输入框上方 |
| Plan 模式 | 共同语义以 `planMode` 区分：Codex 为 `per-turn`，开关存在对话行（迁移 19），派发消息时随 `turn/start.collaborationMode` 送出（沿用对话的模型与深度）；DSH 为 `native`，`setPlan` 执行原生命令，状态来自会话投影并存入 `NativeState.plan`。Workbench 只在轮次之间允许切换，`planReady` 由原生计划条目与本轮终态得出。DSH 的计划审核与 Codex Plan 中的结构化提问走上面的请求通道；界面为 [plan.tsx](../src/web/plan.tsx) 与 [展示组件](../src/web/patterns/plan.tsx) |

## 通知与安装

边界依据 [ADR 0018](adr/0018-push-notifications.md)：只负责推送的 service worker，没有离线缓存。

| 层 | 当前职责 |
| --- | --- |
| 触发 | [push-triggers.ts](../src/server/push-triggers.ts) 接在 Store 的变更回调上，跳过实时条目增量，按对话状态得出事件：本进程看到的运行结束且结果未读（用户停止与正在阅读的不算），或开始等待且无人在读。只记住运行中的对话和有界的最近结果 |
| 发送 | [push.ts](../src/server/push.ts) 为每台设备加密（[web-push.ts](../src/server/web-push.ts)，RFC 8291/8292，`node:crypto`）并发给浏览器推送服务；只接受主流厂商的推送域名，地址不进日志或接口；404/410 删除设备，其他失败记在设备上。消息文案在 [shared/push.ts](../src/shared/push.ts)：对话标题加固定事件文案，不含消息、提问或文件内容 |
| 数据 | 迁移 20：`push_keys` 保存实例推送密钥（首次使用时生成），`push_subscriptions` 保存每台设备的地址、密钥、标签与最近送达情况 |
| 接口 | 私有 `GET /api/private/push`、`POST /push/devices`、`/push/devices/:id/remove`、`/push/devices/:id/test`，沿用认证、来源与 CSRF 检查 |
| 浏览器 | [sw.js](../src/web/public/sw.js) 只显示通知和处理点击（已打开页面就地切换，否则新开窗口）；[push-client.ts](../src/web/push-client.ts) 注册 worker、开启/关闭订阅、识别本设备、保存安装提示并设置角标；设置页「通知」由 [功能层](../src/web/notification-settings.tsx) 与 [展示组件](../src/web/patterns/notifications.tsx) 组成 |

## 自动任务与日程

边界依据 [ADR 0021](adr/0021-automations.md)：调度、持久化与投递归原生 Harness；中书让任务可见、可管理，接住运行结果，并给 Agent 一个“叫用户”的通道。用户路径见[自动任务功能地图](features/automations.md)。

| 层 | 当前职责 |
| --- | --- |
| 接入 | [共同语义](../src/harness/types.ts) 增加可选的 `automations`。[DSH](../src/harness/dsh/automations.ts) 把原生 `schedule/*` 远程方法映射成列出、读取、投递历史、新建、修改（含暂停与恢复，带 `expectedUpdatedAt`）、删除、立即运行，以及读取任务新建的会话（目录与配置）。[连接](../src/harness/dsh/connection.ts) 把 `schedule/changed` 转为变更提示；[历史映射](../src/harness/dsh/native.ts) 把来源为 `schedule` 的用户消息标为投递。Codex 不提供 |
| 服务 | [automations.ts](../src/server/automations.ts) 缓存任务列表（变更提示去抖、每 60 秒兜底重读）。发现新的投递时，让 Workbench 开始观察那段对话；任务在已登记工作区新建的会话，作为属于该任务的对话接入；新建“首次新开后复用”且带配置的任务时，先用 DSH adapter 按配置建好会话并接入，再建指向它的任务；“首次新开后复用”的任务第一次被列出时，记下它预留的会话；完整列表里不再有的任务，它的对话转为普通对话。Workbench 对不是自己发起的运行记下 `state.latest`，用于运行中、未读与推送，不改动自己消息的核对依据；[push-triggers.ts](../src/server/push-triggers.ts) 不推送这类运行的完成。时间轴由 [workspace-documents.ts](../src/server/workspace-documents.ts) 读取每个工作区的 `.zhongshu/timeline.jsonl`（不跟随符号链接，2 MiB 上限），逐行校验 |
| 叫用户 | [agent-tools.ts](../src/server/agent-tools.ts) 在 `127.0.0.1` 的独立端口提供最小 MCP（`initialize`、`tools/list`、`tools/call`），只有 `notify_user` 一个工具，Bearer 令牌比对、拒绝带 `Origin` 的请求。[agent-notifications.ts](../src/server/agent-notifications.ts) 保存通知（有频率上限），从 Workbench 观察到的工具记录（运行中的实时条目，以及变化了的最新历史页）认出所在对话与条目后推送；20 秒内认不出，就推送到日程 |
| 数据 | 迁移 23：对话行的 `automation_id`；`agent_notifications`（摘要、可选文件、落位）；`automation_deliveries`（每个任务处理过的最近一次投递，重启不重复不遗漏）。迁移 24：`automation_reservations`（预留会话）。任务本身不入库 |
| 接口 | 私有 `GET /automations`、`/automations/:id/history`、`/automations/:id/runs`、`/notifications`、`/notifications/:id`、`/timeline`；`POST /automations`、`/automations/:id/edit`、`/delete`、`/run`。沿用认证、来源与 CSRF 检查 |
| 界面 | 侧栏「日程」进入 [schedule-view.tsx](../src/web/schedule-view.tsx)，日期展开与汇总在纯模型 [schedule-model.ts](../src/web/schedule-model.ts)。对话顶部的任务条与运行条在 [conversation-automations.tsx](../src/web/conversation-automations.tsx)，投递消息解析在 [automation-delivery.ts](../src/web/automation-delivery.ts)，侧栏每个任务一行在 [conversation-navigation.tsx](../src/web/conversation-navigation.tsx)。推送点开 `#<对话>:notice:<通知>` 时滚到那一轮并高亮 |

## Harness 账号

边界依据 [ADR 0015](adr/0015-harness-account-status.md)：凭据留在原生 Harness，中书只核实、提醒并发起登录。Codex 用设备码登录；DSH 由用户把跳转地址粘贴回来，中书把其中的 code 和 state 交给 Host 自己的回调。

| 层 | 当前职责 |
| --- | --- |
| 接入 | 共同语义增加 `account`、`startLogin`（`device-code` 或 `paste-back`）、`completeLogin`、`cancelLogin` 与 `onAccountEvent`。[Codex](../src/harness/codex/index.ts) 由读账号、`getAuthStatus` 和读额度得出状态：401 经一次原生刷新仍被拒，或报“无法刷新”，即为失效。[DSH](../src/harness/dsh/index.ts) 由账号状态和资料核实得出状态，并提供用量与充值链接；发起登录时以 launch 文件的回环地址为回调地址，完成登录时只把 code 和 state 交给该地址的 `/oauth/callback` |
| 服务 | [harness-accounts.ts](../src/server/harness-accounts.ts) 在内存中保存每端最近一次核实：启动后、每 30 分钟、原生账号通知、打开设置和手动核实时更新；进入未登录或失效时经推送通知。登录只保存原生登录编号，最多 20 分钟后过期，新发起顶掉旧的；粘贴错的地址不会结束这次登录 |
| 数据 | 不入库；用户码和登录页地址只在发起登录的响应中返回一次，粘贴的跳转地址只在完成登录的请求中出现 |
| 接口 | 私有 `GET /api/private/accounts`、`POST /accounts/:harness/check`、`/accounts/:harness/login`、`/accounts/:harness/login/complete`、`/accounts/:harness/login/cancel`，沿用认证、来源与 CSRF 检查 |
| 界面 | 「设置 → 账户」顶部的账号卡片与设备码面板；对话区上方的提醒条（[功能层](../src/web/harness-accounts.tsx)、[展示组件](../src/web/patterns/harness-accounts.tsx)） |

## 对话观察与删除协调

会话管理边界依据 [ADR 0012](adr/0012-conversation-lifecycle.md)。Workbench 按持久化执行责任恢复，浏览器当前阅读通过有期限的租约共享观察；冷历史只按需读取原生页，不建立永久订阅。事件驱动核对与有界未知状态补偿替代曾打开对话的固定正文轮询。原生驻留仍由 Harness 管理。

未读结果归服务端：Store 在对话行保存已看标记，结果键由当前状态推导（完成、失败、待核实与非用户停止的中断；归档、准备、运行与等待中不计），“看到”即对话打开且页面可见（不要求滚动到底），Workbench 在有效阅读租约开始、释放或到期时写入标记，并经变更流提示各设备重读。租约存续期间到达的结果不计为未读；对话视图带 `unread`，私有 `/attention` 汇总需要关注的对话与未读总数。变更流对每个页面比较对话的列表摘要（标题、工作区、归档、准备与运行状态、错误、未读、子 Agent 计数），只在摘要变化时给 change 事件加 `summary`；Token 用量等内容变化不加。页面据此只在状态变化时刷新侧栏与搜索列表；页面在后台时只更新未读数，回到前台再重读列表。正在打开的对话按变化的范围重读（[ADR 0020](adr/0020-state-only-refresh.md)）：只改状态的变化（操作、运行状态、用量、已读、排队、提问、子 Agent 计数）带 `scope: 'state'`，页面只读 `GET /conversations/:id/state`；原生最新页标记、本轮文件等可能改变历史的变化，以及未归类的变化，才重读完整快照。迟到的完整快照不覆盖较新的状态。

运行中的输出走另一条路（[ADR 0019](adr/0019-live-deltas-and-pure-reads.md)）：Workbench 每 40 ms 把有变化的实时条目编成 `live` 帧，正文和工具输出只带上次发出后追加的部分，不写变更表也不排队；帧带进程纪元与递增序号，`ready`、心跳和快照都带实时位置。页面把帧就地接到本地条目上，不逐帧重读；发现漏帧、帧接不上或持久变化时才重读快照，并重放快照之后收到的帧。读取原生最新页只在页标记与已存的不同时写一条变化，所以重读未变的历史不会再引起重读。

Store 的最近接收消息提交时序支持侧栏分页，游标独立保存排序边界。独立删除日志记录目标身份与清理阶段，变更流记录不再随对话级联消失。Workbench 隔离新提交并核实可删除条件，adapter 执行原生删除，之后事务清理本地内容。Codex 已接入原生删除；DSH 按已确认产品边界仅归档恢复，界面不提供删除且服务端拒绝请求，不维护修改版 Host。当前用户路径与验证方法见[对话管理](features/conversation-management.md)。

## 历史读取与存储边界

依据 [ADR 0014](adr/0014-native-history-source.md)：历史正文以原生 Harness 为唯一来源，中书不保存正文副本，也不补齐缺口。

| 层 | 当前职责 |
| --- | --- |
| 接入 | `history(binding, cursor, limit)` 返回原生页与不透明游标。[Codex](../src/harness/codex/index.ts) 直接调用 `thread/items/list`（分页线程有索引，读取不 `resume`），按条目大小增减每次条数；旧格式线程报 `codex_history_unsupported`。[DSH](../src/harness/dsh/index.ts) 最新页来自快照，旧页只用不激活 Agent 的 `session/page`，游标携带边界轮次，用页内 `turn/start` 推算条目所属轮次 |
| 服务 | [Workbench](../src/server/workbench.ts) 在运行时内存中保持最新页与实时条目：相邻两次读取有重叠时拼接（上限 200 条），早于读取且已结束的实时副本退场；状态与最新页一同读取，历史读取失败只标记可读性，不改变执行核实。旧页由服务端签发、绑定对话身份的游标读取；只含隐藏事件的页向前跳过，超出序列化预算的页以更少条目重读。引用与工作区图片核验先查内存中的近期条目，再从最新页向前有界查找 |
| 数据 | Store 只记录持久变更提示、每段对话的原生最新页标记（迁移 21，[ADR 0019](adr/0019-live-deltas-and-pure-reads.md)）与本轮文件路径；实时增长不落盘；原正文投影表已由迁移 16 删除。[存储预算](../src/server/storage.ts)按数据库在用页面计量，达到预算拒绝上传与新建对话，原生图片副本可淘汰 |
| 接口 | 快照返回最新页、实时条目、`olderCursor` 与可选 `error`；`GET /conversations/:id/state` 只返回状态部分，不含历史；`GET /conversations/:id/history?cursor=` 返回一页；`GET /storage`、`POST /storage/clear-cache` 提供用量与缓存清理 |
| 界面 | [历史窗口](../src/web/history-window.ts)按页组成窗口（≤500 条/8 MiB），每页记住读回它的游标；向上超出时最新端的页带游标离开，向下逐页读回，最后拼回最新页。[工作台](../src/web/workbench.tsx)滚动到两端时自动读取，并以首个可见条目固定阅读位置；[存储入口](../src/web/storage-status.tsx)显示用量与清理 |
