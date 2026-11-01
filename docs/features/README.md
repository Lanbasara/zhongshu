# 功能地图索引

给没有聊天历史的验证 Agent 使用。先识别被测版本和现场，再选下面的场景；每条结论只覆盖实际执行的路径。现有行为的维护源是本目录，模块关系见 [architecture](../architecture.md)，目标和未完成验收见 [spec ledger](../spec/README.md)，原生边界见 [ADR 0001](../adr/0001-native-harness-boundary.md)。

## 按目标进入

| 用户能力 | 地图与场景 | 默认依赖 |
| --- | --- | --- |
| 登录、刷新、退出、密码重置后失效 | [access](access.md)：A01–A05 | 真实应用、两个独立浏览器上下文 |
| 选配置、创建、空对话恢复、核对创建结果 | [conversations](conversations.md)：C01–C05 | fixture；C05 需真实 DSH |
| 发送、接续、停止、未知回执核对 | [execution](execution.md)：E01–E05 | fixture；E05 需真实 Harness |
| 刷新/关页/应用中断后恢复、草稿、长历史 | [continuity](continuity.md)：R01–R06 | fixture；原生恢复需另跑真实分支 |

场景编号用于引用和记录证据，不表示优先级或已通过。每页的 `Implementation and regression` 给出当前代码与定向回归入口。

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

另开终端，将 READY 输出的绝对 root 赋给同名变量，再初始化：

```sh
node test/support/feature-fixture.ts init --root "$zh_verify_root"
```

随机密码只存在 root 下的 `private/password`（`0600`）。浏览器自动化从该文件读入密码字段，不把内容打印到工具输出、命令参数或截图；人工验证使用自己的私密输入通道。刷新后登录。在浏览器中完成用户动作；CLI 只准备边界、控制故障和独立读回。

**浏览器前提**：任意能按可访问名称操作页面、读取 DOM、运行页面脚本、建立独立上下文的工具。仓库不绑定某个浏览器插件。不能建立两个独立上下文时，A03 的第二端记录 `BLOCKED`；两个普通标签页共享 Cookie，不能代替两个登录端。

## Doctor：确认对象和可操作性

1. 保存 `git rev-parse HEAD`、`git status --short`、diff，以及 Node/浏览器版本；工作树有改动时保存补丁和涉及文件的哈希。构建标签只能关联 HEAD，不能证明未提交内容。
2. READY 应给出 `mode: fixture`、本次 PID、root、origin。检查本次 `/api/health` 与 `/api/version`，再打开该 origin；不能用健康接口代替页面验收。
3. 初始化并登录后，应能看到“＋ 新对话”。对话框应列出 Fixture A/B、Codex/DSH、Fixture 模型和两项 fixture 权限。保存实际选值；不能用默认选中推断原生配置。
4. 一般条件等待上限为 10 秒；登录与操作请求上限为 20 秒。fixture 等待的是明确 DOM/接口状态，超时保留最后状态并判失败。真实模型另记录本轮时间预算，超时不自动宣称产品失败。

## Drive：控制与读回

以下命令在仓库根目录执行，使用同一 root。`--title` 必须精确匹配唯一的对话名称；不要复用名称。

```sh
node test/support/feature-fixture.ts inspect --root "$zh_verify_root"
node test/support/feature-fixture.ts complete --root "$zh_verify_root" --title '执行 A'
```

`inspect` 只输出替身身份、固定配置、状态、调用次数与操作编号，不输出密码/Cookie/CSRF。其他控制命令在各场景出现；全量语法可运行 `node test/support/feature-fixture.ts --help`。

需要独立读回产品结果时，在已登录页面同源执行 `fetch('/api/private/workbench/conversations/' + id).then(r => r.json())`，其中 `id` 来自当前地址的 `location.hash.slice(1)`。保存 `conversation`、`operations`、历史条目 ID/正文等合成证据；不要导出 `/api/session` 正文或完整浏览器存储。

受控的丢响应/旧响应与草稿存储故障使用 [browser-faults.js](../../test/support/browser-faults.js)：工具把其导出的 `installBrowserFaults` 函数传入页面执行一次。Playwright 示例（复用执行者已有的浏览器工具）：

```js
const { installBrowserFaults } = await import('./test/support/browser-faults.js');
await page.evaluate(installBrowserFaults);
// 控制前先装载，再做场景中的真实按钮动作。
await page.evaluate(() => window.zhVerify.dropNext('/api/private/workbench/conversations'));
```

其他工具可读取该文件，去掉导出关键字后执行函数。`status()` 的 `held` 非空才表示已捕获响应；`release()` 释放它，`restore()` 恢复 fetch 和存储方法。drop 在服务端应答后丢弃一次响应；hold 故意让旧响应在应用取消后仍返回，以检验时序保护。两者均不改变响应正文。每个故障单独安装/恢复，刷新也会清除注入。

## Native：真实接入分支

使用 [README 的连接配置](../../README.md#harness-connections)，为本次现场准备操作者所有的连接文件，以及两个目录独立、内容相同的合成工作区。不要复制真实数据目录；不要借用正在试用的实例。原生 Host 的启动、登录与执行身份由操作者入口负责，产品仓库不包含本机账号路径。配置中只连接本次明确允许使用的 Host。

另建空 root，显式设置数据目录、空闲端口、origin 和 `ZHONGSHU_HARNESS_CONFIG`，再启动标准应用：

```sh
export ZHONGSHU_DATA_DIR="$zh_verify_root/data"
export HOST=127.0.0.1 PORT=4392
export ZHONGSHU_ORIGIN="http://127.0.0.1:$PORT"
export ZHONGSHU_ALLOW_HTTP_LOOPBACK=true
# ZHONGSHU_HARNESS_CONFIG 必须已指向本次操作者提供的绝对路径。
node src/server/admin.ts init
node dist/server/main.js
```

先核对配置、Host/CLI 精确版本、原生目录、账户可用性和页面目录，再执行 C05/E05/R02 的 native 分支。Codex 与 DSH 分别记录结果；fixture 的权限与协议语义不外推到真实 Host。兼容版本声明见 README，升级后的首次真实工作属于重新核验。

## Evidence：结果能追到对象与动作

每条记录包含：场景编号、HEAD/工作树/构建身份、fixture 或 native、浏览器/Host 版本、root/origin、对话/操作/条目身份、前提、实际动作、预期与观察、证据位置、清理状态。

- `PASS`：本次实际驱动并观察符合判据。
- `FAIL`：前提成立，执行结果不符合判据；保留原始观察。
- `BLOCKED`：缺少明确前提，记录尝试与缺项。
- `UNCOVERED`：本次没有运行的分支。

证据写在仓库外的实验目录或 PR/CI，不写进 feature map。首次补建验证方法还要检验其能识别失败：优先跑已知故障版本；或在隔离副本移除目标行为，使用相同动作与判据得到失败，恢复后重跑。不能在工作实例做破坏实验。

## Cleanup：结束本次现场

先恢复页面故障、关闭自己创建的浏览器上下文。在启动终端 Ctrl-C，等待 `stopped`；核对本次端口已释放。重启场景用相同 serve 命令、相同 root/port；应用停止时 `native.sqlite` 仍由独立控制命令读取，不代表真实 Host 存活。

保留报告、截图和内容身份后，删除本次 root 下的 `private/`、`data/`、`native.sqlite*` 与合成工作区；不删不属于自己的资源。SIGKILL 后锁文件可能残留，serve 只在记录的 PID 已不存在时允许重启。真实工具的清理需另确认 PID、启动标记和目录归属；停止中书、原生轮中断、工具退出分别记录。

## 覆盖边界与维护

只列当前可操作能力。运行中追加、回答提问/审批、附件、成果阅读器/编辑器不在本地图覆盖范围；实现情况与下一切片见 spec。Android 真机、真实 Host 崩溃、VPS/Tunnel、慢网和性能需各自建立现场，桌面 fixture 成功不替代这些证据。

入口、行为、前提或判据随代码变化时更新受影响页。结构与相对引用由 `npm run check:docs` 检查；它不能证明语义或驱动可用。对 SSE 游标、背压和资源上限的协议回归见 [workbench-http.test.ts](../../test/workbench-http.test.ts)，页面恢复由 R01–R06 验证，两者分开记录。
