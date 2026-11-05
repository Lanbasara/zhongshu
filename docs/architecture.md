# 架构：当前实现地图

本文只描述当前实现，随代码演进。长期取舍见 [ADR](adr/)，用户路径见 [feature maps](features/README.md)，共同验证方法见 [features/README](features/README.md)。按用户行为寻找修改与验证路径从 feature map 进入；本图维护模块职责与依赖。文档系统本身见 [ADR 0005](adr/0005-documentation-system.md)。

## 已确认演进的入口

多年使用方案的模块与数据归属见 [ADR 0012](adr/0012-bounded-data-paths.md#目标架构与数据所有权)；永久阅读存档、覆盖与容量承诺见 [ADR 0010](adr/0010-durable-reading-archive.md)，统一执行入口和编辑窗口见 [ADR 0011](adr/0011-managed-workspace-execution.md)。五类问题的交付与联合验收由[上线前联合规格](spec/long-term-performance.md)统筹，全部属于上线前范围。下述代码已接入这些机制；规模、故障、原生链路和独立验收分别取证，不由文档替代上线结论。

下文保留实际模块、调用链及尚存耦合。每个实现切片完成后更新对应现状和 feature map，不因 ADR 已接受就把目标写成已实现，也不提前改写操作者当前连接方式。

## 当前系统

当前实现单管理员私人工作台，通过 Codex 与 DSH 两个 adapter 创建对话、提交图文消息与引用、读取历史与状态、停止当前轮。Workbench 还持有运行中加入的消息队列，派发前将条目内容和发送方式冻结到操作记录。原生进程独立执行并提供接收与归属轮次的证据。公开的版本与健康接口不包含私有状态。

```text
React 浏览器 ──同源 HTTP / SSE──→ Fastify 应用
                                  ├─ 身份、来源与 CSRF 检查
                                  └─ Workbench
                                       ├─ StorageClient ──→ 单一 storage worker ──→ SQLite
                                       ├─ 持久存档任务 ──→ 原生物理读取 worker / 正文分块
                                       ├─ 目录清单 ──→ 独立 directory worker / 可重建索引
                                       └─ 执行登记与门禁 ──→ 受管 gateway ──→ Codex / DSH Host

管理员终端 ──→ 初始化 / 重置 / 一致备份 / 恢复

源码 ──构建──→ dist ──打包──→ 镜像 ──外部发布流程──→ 运行实例
```

## 边界

| 边界 | 当前入口 | 设计理由 |
| --- | --- | --- |
| 页面与服务 | [React 页面](../src/web/main.tsx) / [HTTP 应用](../src/server/app.ts) | 同源接口，私有路由统一认证、来源与 CSRF 检查 |
| 身份 | [auth.ts](../src/server/auth.ts) / [管理员命令](../src/server/admin.ts) / [ADR 0006](adr/0006-auth-session-data.md) | 单管理员、服务端会话、私有数据目录边界 |
| 持久数据 | [StorageClient](../src/server/storage-client.ts) / [worker](../src/server/storage-worker.ts) / [产品迁移](../src/server/migrations.ts) / [ADR 0003](adr/0003-local-persistence.md) | 生产请求的 SQLite 在单一 worker；有界队列、方法白名单、明确结果未知；WAL/FULL、显式迁移、一致备份与新目录恢复 |
| 对话与操作 | [Workbench](../src/server/workbench.ts) / [存储](../src/server/workbench-store.ts) | 派发前落库、未知回执核对、历史身份和原生生命周期统一管理 |
| 原生能力 | [共同语义](../src/harness/types.ts) / [Codex](../src/harness/codex/index.ts) / [DSH](../src/harness/dsh/index.ts) / [ADR 0001](adr/0001-native-harness-boundary.md) | 原生字段与版本差异留在各 adapter；不自行实现 Agent loop |
| 消息与资源 | [内容契约](../src/shared/content.ts) / [资源存储与路径](../src/server/resources.ts) / [正文](../src/web/conversation-content.tsx) / [输入](../src/web/composer.tsx) | 原生解释图片和工具，应用保存授权资源与消息元数据；前端不执行原始 HTML |
| 浏览器恢复 | [公开契约](../src/shared/workbench.ts) / [HTTP 与更新流](../src/server/workbench-http.ts) / [工作台](../src/web/workbench.tsx) / [ADR 0004](adr/0004-recoverable-communication.md) | 稳定操作编号、持久事件水位、有界慢端恢复和旧响应防覆盖 |
| 启动与配置 | [main.ts](../src/server/main.ts) / [config.ts](../src/server/config.ts) / [README](../README.md) | 先验证配置与迁移，再监听；HTTP 开发例外只允许回环 |
| 源码与产物 | [构建脚本](../scripts/build.mjs) / [Dockerfile](../Dockerfile) | 将版本信息嵌入产物，使运行结果能够关联源码提交 |
| 产品与运行环境 | [Compose](../compose.yaml) / [配置示例](../.env.example) | 可配置的运行契约支持不同部署目标，本地开发不需要生产凭据 |
| 产品与发布运维 | 通用镜像及自动化接口 | 源码交付可追溯产物；具体实例的发布、权限与运维知识由操作者在仓库之外维护 |

前后端由一个服务、一个镜像交付，SQLite 位于独立持久卷。框架与驱动的取舍分别归 ADR 0002/0003，身份与恢复操作归 ADR 0006，原生连接、执行限制与配置归 ADR 0001。默认镜像不包含或托管原生服务。

存储 worker 超时或退出后，当前连接停止受理：未发出的命令与结果未知的在途命令分别返回，变更不自动重试。主服务关闭整个所有者并非零退出，由外部有限重启策略重开同一数据；普通队列背压和事务拒绝不触发重启。只把健康标为 unhealthy 不构成进程恢复。重启沿持久操作编号核对原生结果，不能把 worker 失败解释为取消已受理任务或允许重新发送。恢复与有限验收的决定见 [ADR 0013](adr/0013-bounded-recovery-acceptance.md)。

Codex adapter 在已建立连接丢失时报告内部 `unavailable` 事件，由 Workbench 立即持久化“待核实”并撤销配置/终态证明，保留绑定、历史、操作及最后已知运行信息。离线连接尝试失败不重复发失联事件；旧连接事件和旧代次读取不能覆盖后来的状态。重新连接后按原绑定核实配置和原生状态，不自动重发未知操作。公开 HTTP/SSE 仍使用既有状态契约。

已经初始化的受管 Host 停止或不可达时，应用仍可启动并读取持久存档，不因插件能力探测失败而退出。仅持久在线且没有编辑窗口、冻结集合或控制意图的组允许有限恢复；Host ledger 先记录尝试再启动同一容器，每组自动恢复最多三次，成功和网关重启均不清零，耗尽后通过「恢复 Agent」明确重置。恢复与编辑控制共用串行队列，并在启动前复核产品门禁。原生直接子进程意外退出时容器入口至多等待五秒清理再非零退出；原生容器保持 `restart=no`。只读代理按配置保留正文和修订读取入口，每次使用核对当前连接的 Harness 身份及实际能力；连接断开后能力缓存失效，恢复后重新发现。恢复 Host 不代表原任务已结算，未知操作仍沿原身份核对而不重发。决定见 [ADR 0013](adr/0013-bounded-recovery-acceptance.md)。

Web manifest 提供独立窗口入口。有限且已完成的 Markdown 预览按需加载 Streamdown；流式或复杂正文使用原文预览，用按轮折叠的工具组展示原生命令、输出和状态。运行中输入的路径见[执行功能地图](features/execution.md)。原始 HTML 不执行，链接协议受限。审批与提问仍由原生界面处理。

## 当前数据路径与演进边界

| 当前路径 | 实际职责与耦合 | 已确认目标的维护位置 |
| --- | --- | --- |
| 用户提交 → 操作落库 → adapter 派发 | Workbench 持有派发、排队、观察与恢复；观察连接的寿命不等于原生运行寿命 | [执行登记与门禁](adr/0011-managed-workspace-execution.md#持久未决登记与代次) |
| 原生变更 → Workbench → 存储 → SSE 提示重取 | 执行状态、正文覆盖独立持久化；快照读取不重启已有观察或同步循环，存档失败不撤销已证实的执行状态 | [三种事实独立](adr/0010-durable-reading-archive.md#三种事实独立) |
| 原生物理历史 → 持久任务 → 逐页提交 | 每个绑定有 latest/backfill 任务和独立修订水位，不依赖页面访问或观察 runtime；历史页确立顺序，原生追加索引发现旧条目修订，正文与水位同事务提交；全局两个槽，正文每 1 MiB 让出任务 | [可恢复同步](adr/0010-durable-reading-archive.md#可恢复同步) |
| 存储 → 摘要页 / 独立正文 → 浏览器窗口 | 对话快照合计至多 50 个条目、256 KiB；单条文本/工具/引用合用 8 KiB 预览；正文按不可变摘要和 64 KiB 字节块读取；队列编辑和本轮文件另读 | [查询、正文和渲染](adr/0012-bounded-data-paths.md#查询正文和渲染) |
| 历史合并 → storage worker | 按稳定 ID 和索引位置增量合并；局部重排有界，大范围重建在另一套位置列分批推进后原子发布；移除累计对话/历史/操作条数上限 | [存储与调度](adr/0012-bounded-data-paths.md#存储与调度) |
| 文件编辑资格 → 持久运行组 → 独占写者 | 一次旧绑定基线后只跟踪未决受理；冲突闭包一起封门、排空、进程收束，写者就绪后开放编辑；正文按 UTF-8 字节和编码验证再受理保存，未知副作用保留门禁 | [编辑窗口协议](adr/0011-managed-workspace-execution.md#编辑窗口协议) |
| 文件选择 → 代次清单 → keyset 页 | 目录 worker 分批扫描、发布代次，游标绑定目录身份/代次；后台刷新和旧页继续可区分，工作区本身也分页搜索 | [目录清单](adr/0012-bounded-data-paths.md#目录清单) |

状态、历史和传输游标入口在 [Workbench](../src/server/workbench.ts)、[存储](../src/server/workbench-store.ts)、[HTTP](../src/server/workbench-http.ts) 与 [浏览器工作台](../src/web/workbench.tsx)。正文身份、暂存、分块、所有权和校验归 [body-store](../src/server/body-store.ts)；历史位置重建归 [history-order](../src/server/history-order.ts)。旧源游标失效会保留存档并重新锚定，同时标记连续性未确认；源缺口不会因一次新扫描成功而消失。运行中的实时前缀标记 `previewOnly`，不冒充可下载的完整正文；物理记录的可比较修订和终态负责完成它。

应用停止先关闭执行协调与已跟踪工作，再关闭 HTTP、存储与目录所有者。HTTP 关闭释放全部连接，未完成请求正文或慢读客户端不能阻止后续存储关闭；断开浏览器传输不等于向 Harness 发送停止任务。未送达回执仍按持久操作身份核对，不能重发换取确定结果。正常停止与未完成正文反例见 [R02](features/continuity.md#driving-it-with-harness)。

修订流的游标绑定原生源代次与一轮固定上界，每页最多扫描 16 条追加索引记录，再按 ID 点读最新条目；空批次也推进水位。修订顺序不改变历史位置，尚未进入历史的 ID 必须等待历史路径补齐。已完成正文发生变化时，旧版本先保留为不可变正文；稳定重读和流式前缀不累积重复版本。只有历史回填与修订水位都确认，公开状态才可表示同步完整。登记已移除时，后台仍可核对原登记、目录身份和绑定后使用明确只读的物理读取能力；不能由存档获得执行许可或任意原文件读取权限。

有界接入的 Codex reader 读取校验过身份和版本的持久 rollout，DSH reader 读取原生日志并建立稳定条目/工具锚点；巨型标量流式提取，缓存配额和正文租约由各 reader 管理。DSH 专用 Host plugin 缩减状态和 watch 投影。原生 state/watch/reconcile 仍可能加载或激活会话，必须走受控执行许可；物理 history/readItems/body 路径不恢复执行。原生模型运行时的内存成本独立于中书的分页预算，不能据此宣称原生 Agent loop 为常量空间。固定版本和复验归 [execution](features/execution.md) 与 [continuity](features/continuity.md)。

Codex 的旧目标轮核对在 reader 私有缓存中持久保存查询位置，通过有限元数据页跨多次调用继续。位置只决定下一页从哪读，不是终态证明；精确目标和当前状态仍由原生端重新给出。缓存 worker 负责位置 CAS、容量及清理，不进入产品操作账本。正常头页命中不扫描缓存目录，故障和复验路径见 [execution](features/execution.md#e05-真实原生工作)。

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

消息行按视口挂载，离屏使用测量高度占位；历史窗口换页保留位置。完整阅读器每次只解码一块及 UTF-8 边界，全文复制由明确手势触发，下载走有背压的响应流。工作区阅读器和富文本渲染分包。构建为已核验 JS/CSS 生成 Brotli/gzip；产物封存校验压缩版本解压后与原文件一致。只有内容寻址的公开静态资源可长期缓存，HTML 和私人接口保持 no-store。

本轮文件的“当前不可用”是浏览器临时提示，最多保留最近 256 项、合计 64 KiB UTF-16 键文本，超预算淘汰最旧项；切换对话清空。提示不成为文件可用性或权限事实，淘汰后再次打开仍须由服务端实际读取核对，历史窗口回收不会留下无限增长的错误缓存。

侧栏保留最近 256 个工作区的折叠偏好；每组分批读六条对话，继续展开，不展示页码。离屏组用测量高度占位并卸载行。工作区选择使用单个可搜索下拉框；目录按层进入、层内连续滚动。共享 [cursor-window](../src/web/cursor-window.tsx) 每个查询保留最多三个响应批次、128 个稀疏游标；缓存最多 64 个查询且按 4 MiB 估计文本预算淘汰。超出游标预算后回看可从较早书签重新读取，不靠永久累积数据维持滚动。

归档/未归档切换复用查询窗口并保留最近 16 个视图的位置。30 秒内无变更复用缓存；变更事件或缓存过期在原内容上重新核对，不清屏，现有行仍可点击。稀疏搜索缓存命中批次的起点，后台核对不从最初空批次重扫。浏览器缓存是显示提示，归档、发送、文件读取和保存权限仍由服务端重新核对。 SSE 的 `navigation=1` 协商附带工作区与列表元数据摘要；正文、用量和存档进度不改变该摘要。浏览器按工作区失效，跨工作区搜索/归档视图按汇总版本失效；保留最多 512 个对话摘要和 256 个工作区版本，淘汰后保守核对。未协商的旧客户端保持原事件形状，重连/事件缺口仍全量失效当前有界窗口。空结果也是缓存内容，后台核对不移除空状态。

工作区原文编辑按需加载 [CodeMirror](https://github.com/codemirror/view#readme)，文档状态与可见 DOM 分离，避免原生 textarea 在大量行下逐键重排整个文件。仅启用纯文本、键盘和编辑历史，不运行文件内容或加载语言服务；只读、保存和窗口资格仍由产品控制。开放 ShadowRoot 中以 constructed stylesheet 安装库和产品固定主题，兼容现有 CSP，不接收文件提供的样式。换行符、选区和撤销历史由 [编辑器](../src/web/workspace-text-editor.tsx) 维护，起始 BOM 单独作为编码标记保留；预览按当前稿件分页，过大的单一 Markdown 块转为有限原文页。官方 npm 固定 `@codemirror/view` 6.43.15、`@codemirror/state` 6.7.6、`@codemirror/commands` 6.11.1，传递依赖及完整性摘要由 lockfile 固定。

本次使用官方 npm 源固定 Radix UI 1.8.1、Motion 14.9.0；开发工作台使用 Storybook / React Vite 10.6.5，边界 AST 使用 Babel parser 8.1.0。准确依赖树由 lockfile 维护；新增依赖随版本变化重新审查。库负责通用交互机制，产品的视觉语义与组件契约由上述本地模块拥有。

## 消息与资源

共享 schema 约束图片元数据、工具字段与引用；旧文本条目缺少这些字段时仍可读取。原文件引用只保留工作区相对路径，选择、发送及派发校验当前文件；Agent 读取时使用原文件。消息选段保存来源条目与选中文字。Workbench 不重写原操作编号；恢复中的输入仍为同一提交。

图片字节作为 BLOB 与消息元数据同存 SQLite，沿用现有一致备份/恢复。资源属于指定对话，读写均经过私有认证，写入另查来源/CSRF；公开契约只暴露资源 ID，不暴露原生路径。上传只接 PNG/JPEG/WebP，服务端核验魔数和字节：每张输入最多 2 MiB、每消息最多 4 张且合计 4 MiB；原生输出/工作区图片最多 6 MiB。生产 Workbench 使用统一容量准入，不再用累计图片 512 MiB 作为年限上限。未关联上传在候选索引中分批清理超过 7 天的项；pending 操作与历史关联的资源持续保留，移除不会删除已关联资源。

Codex 以原生 image input、DSH 以原生 image content 接图片，无需新增 Host 挂载。生成结果仅采集原生返回的图片字节或原生文件读取结果；失败显式显示。Markdown 工作区图片先验证消息来源、相对路径与非符号链接边界，再通过对应 Host 文件接口读取，按消息/来源保存首次可读快照；原文件之后移走仍能回看。它不是任意宿主文件代理。HTTPS 图片在浏览器直接请求并禁用 referrer；HTML、SVG 与可执行 URL 不通过本地资源通道。

输入草稿的文本/已上传资源/引用沿用 sessionStorage；失败或中断的上传文件单独在 IndexedDB 暂存，重新加载后需明确重试。发送前必须先持久化操作编号及原提交内容；上传未完成或暂存失败不会悄悄只发文本。退出清理浏览器草稿与暂存。两端文件读取与生成能力的具体差异留在 adapter，验证入口统一归 [对话基本可用性](features/conversation-usability.md)。

单次输入限制与永久存档容量是不同边界。[storage-capacity](../src/server/storage-capacity.ts) 实时计量主库/WAL、分批计量数据目录其他文件并检查文件系统余量。容量不足暂停新工作/上传及不能完成的回填，保留旧档和已受理任务；扩容后按余量与回差重新开放。暂存有独立预算，已发布正文版本不会因临时缓存清理而消失。Host 和独占文件写者的效果账本独立保留，不能随产品数据库回滚。承诺与退出条件见[容量规格](spec/storage-longevity.md)。

管理员备份与恢复由 [database](../src/server/database.ts) 在私有暂存副本上核对已发布正文的所有权、分块顺序、字节数与完整摘要，校验通过才发布文件；未完成暂存继续保留其未完成状态。全量核验不放入在线应用启动或请求路径。

技能目录从当前对话绑定的 Harness 读取。私有接口给浏览器显示信息和不透明 ID，草稿与操作保存已选技能的 ID 及文本位置。派发时 adapter 按原生清单核对并转换为本端输入。用量由 adapter 从原生事件或当前投影读取，Workbench 保存每段对话最近一次已确认的用量快照，通过原有变更流提示页面重取。复验见[技能引用](features/conversation-usability.md#u12-技能引用)与[对话用量](features/conversation-usability.md#u13-对话用量)。

仅当已实现的变更影响本图应描述的模块职责、依赖、共享接口或数据归属时，更新受影响的条目。用户能力的入口、行为、实现定位和验收方法归对应的 [功能地图](features/README.md)。尚未实现的设计留在对应 spec 或 ADR 中。

## 工作区文件

阅读器以登记的工作区和相对路径定位原文件。私有工作台 API 提供目录、文件正文、可编辑状态和带版本的保存。正文不进入 SQLite。只读 HTML 在禁止脚本和网络资源的 iframe 内显示，由工作台解析同工作区底稿链接并恢复阅读位置。

Harness Adapter 提供可归因的编辑目标。工作台在写入历史或实时条目时记录对话、原生轮和工作区相对路径，转发当前历史页所涉及的清单。清单与文件内容分开读取，打开时仍走原工作区阅读器。

可写工作区由操作者声明写入边界。[execution-store](../src/server/execution-store.ts) 持有受理、冲突组、固定冻结集合、原生基线检查点和保存许可，与工作台入队、领取同事务登记。[execution-coordinator](../src/server/execution-coordinator.ts) 驱动 online → draining → editable → resuming；[execution-workspaces](../src/server/execution-workspaces.ts) 将持久协议接入工作区。首次旧绑定检查按 keyset 分批，此后编辑只追踪未决工作。相交可写挂载的组一起冻结，原生激活入口必须经过可信许可与 gateway，包括可能恢复原生会话的状态读取。

两个 Harness 的原地保存要求受管专用 Host。固定受理集合排空后，控制器证明 Host 及其写者退出，才开放编辑。保存或关闭页面不解除窗口，必须显式恢复。控制意图在外部动作之前持久化，代次与 epoch 拒绝旧结果；未知状态关闭门禁，不自动取消或重发任务。

[execution-sandbox-policy](../src/server/execution-sandbox-policy.ts) 为受管 Codex 提供固定原生版本的内层沙箱兼容规则；[Moby 默认清单](../src/server/moby-seccomp-default.ts)保留原规则与许可证，只增精确参数的 namespace/mount 调用，DSH 继续使用 Docker 默认策略。规则摘要进入 Host 持久身份；Docker 退出证明同时核对非 root 身份、只读根、capabilities 和实际安全选项，原标签不能掩盖这些配置漂移。支持的架构与宿主策略前提归 [README](../README.md#managed-host-deployment)，不因原生 catalog 宣称权限可用就省略真实工具验证。

[workspace-writer](../src/server/workspace-writer.ts) 的独立子进程是唯一受管文件写者，以单独 SQLite owner 事务持有操作系统锁，保存 intent 与结果另存持久日志。版本由文件内容和身份共同决定；替换与目录同步后才确认成功。主库未决保存跨重启恢复时，新 owner 先取得同一锁，再以旧版本和新摘要判断成功、未写入或未知，不重复不确定副作用。操作者配置稳定的独立写者目录，Host 配置摘要绑定该目录；产品库备份恢复不得回滚或替换这些 owner/Host 日志。边界取舍见 [ADR 0011](adr/0011-managed-workspace-execution.md)，当前行为和复验归[文件功能地图](features/workspace-files.md)。

标题及工作区名称搜索保留任意子串语义。存储 worker 先按排序索引和 keyset 游标读取固定原始候选批次，再做匹配；`conversation-search` 与工作区 `page` 的游标指向已扫描位置，而非只指向最后命中。空批次保留 continuation，前端只持有当前结果页和有限游标。全库稀疏搜索仍是线性总工作量，但单个请求不会持有 worker 遍历终身记录；预算与复跑见[对话管理](features/conversation-management.md)和[工作区管理](features/workspace-management.md)。

## 工作区登记

操作者配置可登记的目录根和原生连接。工作区登记、显示名、置顶与移除状态由 SQLite 持久化。旧配置中的登记首次导入时沿用 ID，后续启动保留已保存的状态。工作台在文件访问和原生派发前核对登记和目录身份。移除期间检查关联对话的原生状态，停用登记与操作受理互斥。恢复沿用原登记，旧对话重新验证原生绑定后接续。操作入口和复验见[工作区管理](features/workspace-management.md)。

工作区导航、添加目录及文件选择共用服务端游标分页，前端用连续滚动承接；选中但不在当前页的工作区按 ID 单独读取。[directory-index](../src/server/directory-index.ts) 和 worker 提供代次、继续游标、刷新进度与全局缓存预算；清单可重建，登记和真实文件身份仍是授权依据。规模与目录变动复验见[目录与导航规格](spec/workspace-directory-index.md)。

## 实例级插件管理

工作台私有路由和 SQLite 持有操作身份、回执和核实状态；安装、版本、启用状态以选定 Harness 的原生清单为准。每端一次只受理一个未决变更；请求丢失后按原操作 ID 读回，不自动重发。

Codex 经专用 Unix socket 管理进程调用固定 CLI 和同一实例的 App Server；管理进程核对连接身份、实例状态目录和操作者固定的 Git 市场。DSH 在该实例的 Web Host 上调用原生目录和包管理 API，并按市场核对包来源。中书管理员添加公开 GitHub 来源时，Codex 管理进程持有市场提交和身份，DSH Web Host 持有索引设置；来源变更与同端安装操作互斥。两个 Harness 保留各自的来源、标识和加载语义。长期取舍见 [ADR 0009](adr/0009-instance-plugin-scope.md)，原生连接配置和复验入口见[插件管理功能地图](features/plugin-management.md)。
