# 功能地图索引

给没有聊天历史的验证 Agent 使用。先识别被测版本和现场，再选下面的场景；每条结论只覆盖实际执行的路径。现有行为的维护源是本目录，模块关系见 [architecture](../architecture.md)，目标和未完成验收见 [spec ledger](../spec/README.md)，原生边界见 [ADR 0001](../adr/0001-native-harness-boundary.md)。

## 按目标进入

| 用户能力 | 地图与场景 | 默认依赖 |
| --- | --- | --- |
| 主界面、输入交互、组件工作台与发布隔离 | [interface](interface.md)：I01–I05 | fixture、浏览器与本地构建；原生链路按关联地图 |
| 登录、刷新、退出、密码重置后失效 | [access](access.md)：A01–A05 | 真实应用、两个独立浏览器上下文 |
| 工作区草稿、首发创建、默认回退、思考深度与核对首发 | [conversations](conversations.md)：C01–C10 | fixture；C05/C08/C09 原生分支需真实 Harness |
| 工作区分组、侧栏调整、搜索与跳转、重命名、归档、删除、存储预算与未读同步 | [conversation-management](conversation-management.md)：M01–M10 | fixture、真实 Harness 与手机分支 |
| 发送、接续、停止、排队与提前发送 | [execution](execution.md)：E01–E07 | fixture；原生轮次与接收语义需真实 Harness |
| 刷新/关页/应用中断后恢复、草稿、连续回溯长历史与停机缺口 | [continuity](continuity.md)：R01–R07 | fixture；原生恢复与长历史需另跑真实分支 |
| 完整图文对话、工具阅读、输入与引用、本轮文件、技能、用量、恢复接续 | [conversation-usability](conversation-usability.md)：U01–U13 | 两个真实 Harness、合成图片及工作区文件 |
| 查看主 Agent 派生的子 Agent 与 DSH 团队，单独停止子 Agent | [subagents](subagents.md)：S01–S09 | fixture；原生派生、停止与团队需真实 Harness |
| 工作区文件、只读 HTML 与条件保存 | [workspace-files](workspace-files.md) | 浏览器、合成报告与纯文本、两个真实 Harness |
| 添加目录、管理、移除与恢复工作区登记 | [workspace-management](workspace-management.md) | fixture、两个真实 Harness、本地与 VPS 测试实例 |
| 实例级插件发现、安装、启停与卸载 | [plugin-management](plugin-management.md)：P01–P05 | 浏览器、隔离的 Codex 与 DSH 原生环境 |
| 开启推送、完成/失败/等待提醒、点击直达、设备管理与安装 | [notifications](notifications.md)：N01–N07 | 能连上推送服务的真实浏览器；触发分支需真实 Harness |
| 日程与原生自动任务、自动运行的结果、Agent 主动通知、工作区时间轴 | [automations](automations.md)：T01–T10 | 真实 DSH 0.2.2+；主动通知需操作者配置的通知工具 |
| 用 `sichen` 命令说人话地管理定时任务（含结束日期、回到本对话）与日历条目 | [sichen](sichen.md)：S01–S08 | 真实 DSH 0.2.2+；操作者配置的 `agentTools`，`sichen` 与令牌放进 DSH 运行环境 |
| Agent 照官方写法用 `chrome-devtools` 操作实例唯一的浏览器：一段对话一个窗口、排队、闲置收回、用时才开 | [simen](simen.md)：B01–B10 | 真实 DSH；操作者配置的浏览器服务（司门宿主 + Chromium + 固定版本 chrome-devtools-mcp）与 `agentTools.browser` |
| 查看两端账号状态、失效提醒、Codex 设备码续登 | [harness-accounts](harness-accounts.md)：H01–H05 | 真实 Harness；登录类分支需隔离的 Codex |

场景编号用于引用和记录证据，不表示优先级或已通过。每页的 `Implementation and regression` 给出当前代码与定向回归入口。

## 独立执行验收

新增或实质修改地图的方法必须经过至少两个不继承作者聊天历史的验证 Agent 实际执行，决策见 [ADR 0007](../adr/0007-independent-feature-map-verification.md)。两人可按 Harness/场景分工，但受影响的驱动方法都要被独立执行，核心端到端旅程各跑适用分支；纯文字整理不要求重跑。

1. 只交付仓库入口、被测版本/范围和资源归属；验证者从 `AGENTS.md`、本索引及正常链接发现方法。允许供应地图明确要求的操作者配置、凭据的安全使用通道及隔离现场，不提供作者旧聊天、成功结论或未文档化的导航步骤。
2. 使用各自的应用/数据/浏览器上下文，从用户入口施加动作并取得独立观察。不能只审文档、读源码或跑单元测试；也不能把作者一次性脚本的成功当成自己已按图驱动。
3. 按场景记录 PASS/FAIL/BLOCKED/UNCOVERED，区分产品缺陷、地图缺口、驱动错误与前提缺失。作者修复产品/地图后由独立者复跑；不能省掉失败分支或口头带路换取通过。
4. PR/仓库外证据保留被测提交/差异、执行者与独立上下文声明、场景分工、动作/预期/观察、失败与修订、未覆盖项和清理结果；按实际覆盖声明完成。两个 Agent 参与不等于整图通过，阻塞/未覆盖不能冒充 PASS。地图中不存一次运行状态。

作者自测与本验收分别回答“行为是否成立”和“陌生执行者能否按地图验证”。`check:docs` 只检查结构与链接，不能替代任何一项。

## 两种现场与证明范围

| 现场 | 真正运行的部分 | 不能由它证明的部分 |
| --- | --- | --- |
| `fixture` | React 构建产物、源代码 Fastify / Workbench / SQLite / HTTP / SSE、浏览器动作；只在 `HarnessAdapter` 边界接确定性替身 | Codex/DSH 协议、模型上下文、工具执行、原生权限、Host 崩溃恢复 |
| `native` | 标准 `dist/server/main.js`、已配置的真实原生 Host、真实模型与合成工作区 | 未运行的另一 Harness、另一设备、代理链路、故障和性能分支 |

fixture 的模型标签明确写“非真实模型”。控制命令只改替身自己的 `native.sqlite`，不写产品数据库或伪造浏览器响应正文。真实 Host 需要操作者提供隔离账号、受限执行身份和连接文件；缺少这些前提时记录 `BLOCKED`，仍可跑 fixture。

## Launch：从干净克隆开始

仓库根目录执行；Node 版本见 [.node-version](../../.node-version)。依赖与通用命令见 [README](../../README.md)。验证入口不需要新增 npm 包、生产数据或全局配置。

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
REVISION="$(git rev-parse HEAD)" npm run build
npm run check:docs
zh_verify_root="$(mktemp -d "${TMPDIR:-/tmp}/zhongshu-verify.XXXXXX")"
chmod 700 "$zh_verify_root"
node test/support/feature-fixture.ts serve --root "$zh_verify_root" --port 4391
```

最后一条常驻前台。端口被占用时退出，不接管已有进程；换一个空闲端口并同步浏览器 origin。同一 root 同时只运行一套应用。此入口忽略个人 `ZHONGSHU_*` 配置，首次要求 root 为空且权限为 `0700`；新现场**尚未初始化管理员**，先跑 A01。修改源码或重新构建后重启应用；静态路由在启动时登记，不能边重建 dist 边把旧进程当作新版本验收。

另开终端，等 serve 输出 `"event":"ready"` 的 JSON 行，把其中的绝对 root 赋给同名变量，再初始化：

```sh
node test/support/feature-fixture.ts init --root "$zh_verify_root"
```

本地实例的管理员密码是 `zhongshu-local`，浏览器与人工验证直接输入；fixture 的 `reset` 把它改为 `zhongshu-local-reset`。规则见 [ADR 0006](../adr/0006-auth-session-data.md)。刷新后登录。在浏览器中完成用户动作；CLI 只准备边界、控制故障和独立读回。

**浏览器前提**：任意能按可访问名称操作页面、读取 DOM、运行页面脚本、建立独立上下文的工具。仓库不绑定某个浏览器插件。不能建立两个独立上下文时，A03 的第二端记录 `BLOCKED`；两个普通标签页共享 Cookie，不能代替两个登录端。

## Doctor：确认对象和可操作性

1. 保存 `git rev-parse HEAD`、`git status --short`、diff，以及 Node/浏览器版本；工作树有改动时保存补丁和涉及文件的哈希。构建标签只能关联 HEAD，不能证明未提交内容。
2. ready 行应给出 `mode: fixture`、本次 PID、root、origin。检查本次 `/api/health` 与 `/api/version`，再打开该 origin；不能用健康接口代替页面验收。
3. 初始化并登录后，应能看到“新对话”。工作区“＋”直接进入草稿，hash 为 `#new:<工作区ID>`，不弹表单、不提前创建正式对话；DSH 会准备原生空会话，按 C10 核对；全局无历史且多工作区时先选区。输入框内选择 Codex/DSH、Fixture 模型、思考深度和 fixture 权限。Codex 可靠默认是 fixture-model / medium；DSH 须明确选择，无原生默认。保存选值；首次发送/核对成功后等 hash 变成本次对话 ID，再核对标题、状态、正文及 inspect。草稿或旧对话的输入框存在不能证明新对话已创建。
4. 一般条件等待上限为 10 秒；登录与操作请求上限为 20 秒。fixture 等待的是明确 DOM/接口状态，超时保留最后状态并判失败。真实模型另记录本轮时间预算，超时不自动宣称产品失败。
5. 进程中断前，核对应用自身 PID、实际端口监听者和本次数据目录。`spawn` 返回的 PID 可能只是 Node/Volta 启动器；不能只杀启动器就宣称应用中断。停止后需确认实际监听者退出、端口无监听且健康请求连接被拒绝，再执行停机期间的动作。重启后同样记录新监听者与版本。

## Drive：控制与读回

以下命令在仓库根目录执行，使用同一 root。`--title` 必须精确匹配 inspect 中唯一的原生创建标题；不要复用名称。新建不再单独填标题：首条文字折叠空白后截取前 32 个 Unicode 字符作为标题，无文字为“新对话”。下文命令的示例标题都须替换成本轮 inspect 实际值；页面重命名只改产品标题，不能假定原生控制标题也改变。

页内切换可用侧栏，也可直接改变地址。每个页面有自己的 hash：对话 `#<ID>`、草稿 `#new:<工作区ID>`、`#schedule[:标签]`、`#settings[:标签]`、`#archive`。已打开页面改变 hash（包括自动化工具的同文档导航）和浏览器后退、前进都会切换到对应页面，行为与验证见[界面 I07](interface.md)。判定仍以标题与内容的变化为准，不能只看地址变化。

```sh
node test/support/feature-fixture.ts inspect --root "$zh_verify_root"
node test/support/feature-fixture.ts complete --root "$zh_verify_root" --title '执行 A'
```

`inspect` 只输出替身身份、固定配置、状态、调用次数与操作编号，不输出密码/Cookie/CSRF。其他控制命令在各场景出现；全量语法可运行 `node test/support/feature-fixture.ts --help`。

需要独立读回产品结果时，在已登录页面同源执行 `fetch('/api/private/workbench/conversations/' + id).then(r => r.json())`，其中 `id` 来自当前地址的 `location.hash.slice(1)`。保存 `conversation`、`operations`、历史条目 ID/正文等合成证据；不要导出 `/api/session` 正文或完整浏览器存储。

受控的丢响应/旧响应、草稿存储和发送请求拒绝故障使用 [browser-faults.js](../../test/support/browser-faults.js)：工具把其导出的 `installBrowserFaults` 函数传入页面执行一次。Playwright 示例（复用执行者已有的浏览器工具）：

```js
const { installBrowserFaults } = await import('./test/support/browser-faults.js');
await page.evaluate(installBrowserFaults);
// 控制前先装载，再做场景中的真实按钮动作。
await page.evaluate(() => window.zhVerify.dropNext('/api/private/workbench/conversations'));
```

其他工具可读取该文件，去掉导出关键字后执行函数。`status()` 的 `held` 非空才表示已捕获响应；`release()` 释放它，`restore()` 恢复 fetch 和存储方法。drop 在服务端应答后丢弃一次响应；hold 故意让旧响应在应用取消后仍返回，以检验时序保护。`rejectNextRequest(path, 400或413)` 只匹配同源指定对话的下一次发送POST，通过未知字段/超限字段触发真实服务端拒绝，见 [E04](execution.md)。这些工具均不改变响应正文，journal只留路径/方法/状态/操作ID，不记认证头或消息。每个故障单独安装/恢复，刷新也会清除注入。

## Native：真实接入分支

使用 [README 的连接配置](../../README.md#harness-connections)，为本次现场准备操作者所有的连接文件，以及两个目录独立、内容相同的合成工作区。不要复制真实数据目录；不要借用正在试用的实例。原生 Host 的启动、登录与执行身份由操作者入口负责，产品仓库不包含本机账号路径。配置中只连接本次明确允许使用的 Host。

操作者明确用于实验的既有登录可以复用；本次 Host 使用独占连接地址，只创建本轮会话，不操作既有会话或改账号配置。不同 OS UID 不是唯一隔离方式；同 UID、HOME 目录隔离、权限 profile 名称也不能单独证明有效边界。按 [ADR 0001](../adr/0001-native-harness-boundary.md) 核对实际 HOME、原生数据、工作区及必要系统依赖；使用本次明确不允许区域的合成 canary，从原生工具结果核验读/写限制，不接触真实凭据。只限制写入但仍能读取认证数据所在区域，不满足所需读取边界。行为已观察到、环境隔离前提合格，是两项分别记录的结论。

读取边界必须覆盖整个 Host：分别驱动真实 shell 和原生文件 read/write 工具，核对禁止区域的读/写均拒绝、允许工作区的读/写成功，并由可信端独立读回准确字节。保留 tool/call 与 tool/result 的对应关系；不能用 shell 代替原生文件工具，也不能只凭模型总结或启动参数。禁止区域 canary 内容不要预先给模型；必要运行依赖及专用原生目录本来可以读取，不能把“所有工作区外文件不可读”当作判据。

DSH rc.4 的原生 workspace-write 只围栏写入，原生文件读取也不按工作区限制；操作者需提供额外有效的完整 Host 边界。容器/VM 现场应先核对实际非 root 身份、镜像/启动配置、最小挂载及连接暴露，确保中书认证数据、其他宿主区域与宿主管理通道不进入执行环境。未挂载文件的不可见（ENOENT）与实际存在但拒绝访问（EACCES）分别记录；后者须由可信监督端先确认合成文件确实存在。内外路径不同时先说明映射；产品与原生 cwd/绑定仍须一致，不能只凭目录名字签通过。本机启动方法与凭据仍从仓库外的操作者入口取得。

容器中的 PID 属于其进程命名空间，必须连同 container/VM 身份在该执行环境内核对工具存活、cwd 与退出，不能用宿主相同数值的 PID 代替。容器停止回收进程树、DSH 原生 cancel 的轮次中断和外部释放 gate 是不同动作；停止/恢复证据分别标明实际使用哪一种。

另建空 root，显式设置数据目录、空闲端口、origin 和 `ZHONGSHU_HARNESS_CONFIG`，再启动标准应用：

```sh
export ZHONGSHU_DATA_DIR="$zh_verify_root/data"
export HOST=127.0.0.1 PORT=4392
export ZHONGSHU_ORIGIN="http://127.0.0.1:$PORT"
export ZHONGSHU_ALLOW_HTTP_LOOPBACK=true
# ZHONGSHU_HARNESS_CONFIG 必须已指向本次操作者提供的绝对路径。
node dist/server/main.js
```

未设置 `ZHONGSHU_ADMIN_PASSWORD` 时，本地应用启动即以 `zhongshu-local` 初始化管理员。先核对配置、Host/CLI 精确版本、原生目录、账户可用性和页面目录，再执行 C05/E05/R02 的 native 分支。Codex 与 DSH 分别记录结果；fixture 的权限与协议语义不外推到真实 Host。兼容版本声明见 README，升级后的首次真实工作属于重新核验。

## Evidence：结果能追到对象与动作

每条记录包含：场景编号、HEAD/工作树/构建身份、fixture 或 native、浏览器/Host 版本、root/origin、对话/操作/条目身份、前提、实际动作、预期与观察、证据位置、清理状态。

- `PASS`：本次实际驱动并观察符合判据。
- `FAIL`：前提成立，执行结果不符合判据；保留原始观察。
- `BLOCKED`：缺少明确前提，记录尝试与缺项。
- `UNCOVERED`：本次没有运行的分支。

证据写在仓库外的实验目录或 PR/CI，不写进 feature map。首次补建验证方法还要检验其能识别失败：优先跑已知故障版本；或在隔离副本移除目标行为，使用相同动作与判据得到失败，恢复后重跑。不能在工作实例做破坏实验。

## Cleanup：结束本次现场

先恢复页面故障、关闭自己创建的浏览器上下文。在启动终端 Ctrl-C，等待 `stopped`；核对本次端口已释放。重启场景用相同 serve 命令、相同 root/port；应用停止时 `native.sqlite` 仍由独立控制命令读取，不代表真实 Host 存活。

保留报告、截图和内容身份后，删除本次 root 下的 `data/`、`native.sqlite*` 与合成工作区；不删不属于自己的资源。SIGKILL 后锁文件可能残留，serve 只在记录的 PID 已不存在时允许重启。真实工具的清理需另确认 PID、启动标记和目录归属；停止中书、原生轮中断、工具退出分别记录。

## 覆盖边界与维护

只列当前可操作能力。回答提问/审批、通用文档附件的范围见 spec。Android 真机、真实 Host 崩溃、VPS/Tunnel、慢网和性能需各自建立现场，桌面 fixture 成功不替代这些证据。

入口、行为、前提或判据随代码变化时更新受影响页。结构与相对引用由 `npm run check:docs` 检查；它不能证明语义或驱动可用。对 SSE 游标、背压和资源上限的协议回归见 [workbench-http.test.ts](../../test/workbench-http.test.ts)，页面恢复由 R01–R06 验证，两者分开记录。
