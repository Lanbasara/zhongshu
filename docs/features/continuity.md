# 接续与阅读：feature map

当前能力：恢复同一对话、当前标签页保留草稿/未确认发送、从原生连续回溯任意长度的历史、停机缺口后直接接上最新内容与处理晚到响应。历史正文以原生 Harness 为唯一来源，中书不保存正文副本（[ADR 0014](../adr/0014-native-history-source.md)）；其余持久化和恢复语义见 [ADR 0003](../adr/0003-local-persistence.md)、[ADR 0004](../adr/0004-recoverable-communication.md)。

## Sub-features

| 场景 | 要证明的行为 |
| --- | --- |
| R01 | 关页后工作不被浏览器取消；重开同一地址能读回结果 |
| R02 | 中书进程中断后保留绑定和操作，核对原生结果，不盲目重派 |
| R03 | 草稿按对话保存在当前标签页，支持刷新/切换；独立端不共享 |
| R04 | 从原生连续回溯到第一条再回到最新；浏览器窗口有界，不重复、不漏项、不错位 |
| R05 | 旧对话/旧版本快照不能覆盖当前页面和较新结果 |
| R06 | 原生断连时保留已加载内容、说明原生暂不可用并阻止新发；恢复后沿原身份继续阅读与核对 |
| R07 | 中书停机期间原生新增大量内容，重开后首屏即最新、可以发送，向上能连续读到停机前内容 |

## How to get to it (user POV)

侧栏选择对话，或打开带该对话 hash 的地址。标题栏「对话操作」菜单的“重新连接并刷新状态”刷新当前快照和目录。滚动到顶部会自动读取更早一页（也可点“查看更早的内容”），到第一条时显示“这是对话的开头。”；向上读了很多页后，最新端的页会离开窗口，顶部显示“正在阅读较早的内容。回到最新内容”，底部出现“查看更新的内容”，滚动到底部会把它们逐页读回；滚离底部后新输出显示“↓ 有新内容”。原生读取失败时历史区显示“原生暂时不可用…”和“重试”，已加载内容保留。没有成果文件阅读器；这里阅读的是对话正文和可展开的工具组。

## Driving it with Harness

按 [共同入口](README.md) 建 fixture；先用 E01 建立有已知内容与身份的对话。关闭/重开必须复用本次浏览器上下文，另一个独立上下文用于检验服务端读回。每次保存 hash、fixture 原生 ID、operation ID 和条目 ID/正文。

| 场景 | 初始条件与动作 | 判据和反例 |
| --- | --- | --- |
| R01 | 在“离开恢复”发消息，确认 inspect 已调用一次且 running；关闭该页，CLI complete，再在同一上下文新页打开原 URL；B 另开新页或完整刷新原 URL | 两端均读到同一用户条目和完整完成正文，原生身份相同、submitCalls 仍为 1。关页之后才执行 complete，避免把关闭前已完成误认为离开期间完成 |
| R02 | 在“中断恢复”发消息，确认 running；按共同 Doctor 核对本次实际应用/监听 PID 后 SIGKILL；确认进程与端口均不存在，再由独立 CLI complete。以相同 root/port 启动并确认新监听者，重新打开原 hash | 同一原生 ID、同一 operation ID，accepted 与终态被核实，用户/助手正文各一份，submitCalls=1。只杀 Node 启动器、旧应用仍监听不能通过；fixture 原生状态在独立数据库，这只证明应用对边界持久状态的恢复 |
| R03 | 当前页 A 输入独有草稿但不发送，切换另一对话再回来，刷新；在独立端 B 打开相同 hash；A 退出后重新登录 | A 切换/刷新后草稿逐字相同，B 无此草稿；A 明确退出后草稿清空。pending 发送的保留与核对另跑 E02。创建前每工作区草稿、刷新与应用重启另跑 [C02/C03](conversations.md)。新标签/关页后的 sessionStorage 生命周期不作为持久化承诺 |
| R04 | 用正常首发建立“长历史”（C01 路径），`complete` 收尾后用 `append` 追加 5,000 条（每条 120 字符）；打开该对话，从顶部持续滚动直到“这是对话的开头。”，再持续滚动到底部 | 首屏末条为最后追加的编号；向上逐页读取，编号连续、不重复，最终到达首条用户消息；任何时刻 `.message-text` ≤ 500；回到底部时末条恢复为最新编号，且最后一次衔接不重置窗口。另用 `seed --count 150 --chars 50000` 的空会话检验大正文：每页完整、不截断正文尾部。记录 DOM 与公共快照，不能只统计请求次数 |
| R05 | 创建标题/内容不同的 A、B；用故障工具捕获 A 的下一次 GET 快照，切 B 后再释放。另在运行中的 A 捕获旧快照，切 B，CLI complete A，再从侧栏切回 A，等新正文到达后释放旧响应 | 第一分支仍显示 B 标题/正文/hash，不混入 A；第二分支仍显示完成正文/终态。切走/切回使新一代读取能越过被挂起的旧请求；同一视图的读取会合并，不能等一个被合并的请求自行超车。必须先确认 held 捕获、后观察新状态、再 release |
| R06 | 在已加载多页的“断连恢复”执行 disconnect，从「对话操作」点“重新连接并刷新状态”，再向上滚动、尝试发送；然后 reconnect 并“查询原生结果”/“重试” | 断连时已加载正文全部保留，历史区显示“原生暂时不可用”，向上读取给出“原生历史暂时无法读取…”而不清空窗口，状态待核实且新文本不派发；恢复后原生身份与历史保持，submitCalls 不变，向上读取恢复，状态核实后可发。fixture 的断连不是实际 Host 崩溃，不能宣称原生进程恢复 |
| R07 | “停机缺口”对话 `complete` 后按 Doctor 停止本次应用并确认端口无监听；停机期间 `append --count 5000`；以相同 root/port 重启并打开原 hash，向上读取若干页，再发送一条消息 | 首屏为最新编号，状态不因历史出现待核实，发送被接收；向上读取连续到达停机前的条目；应用数据库中没有任何正文表或正文副本。反例：仍提示“历史较多尚未补齐”或禁发 |

```sh
node test/support/feature-fixture.ts append --root "$zh_verify_root" --title '长历史' --count 5000 --chars 120
node test/support/feature-fixture.ts seed --root "$zh_verify_root" --title '长正文' --count 150 --chars 50000
node test/support/feature-fixture.ts disconnect --root "$zh_verify_root" --title '断连恢复'
node test/support/feature-fixture.ts reconnect --root "$zh_verify_root" --title '断连恢复'
```

seed 仅允许没有消息和既有历史的 fixture 对话；append 可用于任何 fixture 对话，在原生替身末尾追加 `APPEND NNNNNN ` 右补 `x` 的条目，可在应用停止时执行以制造停机缺口。两者都只写替身的 native.sqlite，不写产品数据库。R04/R07 在浏览器可用 `.message-text` 读取每条完整 `textContent`，检查长度、编号与末字符；这属于结果观察，不通过内部写入制造成功。

R05：在对应 A 页面安装 browser-faults，执行 `zhVerify.holdNext('/api/private/workbench/conversations/' + location.hash.slice(1))`，从「对话操作」点“重新连接并刷新状态”，等待 held，再按表中顺序通过侧栏切换。确认新结果可见后 `release()`，等待 held 清空再检查标题、正文与快照。若页面工具无法控制该顺序，单列 `BLOCKED`；直接快速点击不等于确定覆盖。

R01/R02 的 native 分支使用 [E05 的受控 gate](execution.md)：确认真实工具已启动后关页或只停中书；从可信端确认本次 Host 与 gate 仍存活，再创建 release 文件；读回 finished 文件、重新打开同一对话。保存实际进程身份。真实 Host 单独突然崩溃需要操作者提供可销毁的独立 Host；有权限且实际完成该实验前，不能用中书进程崩溃替代。Android 后台/回收和移动网络也需在真机另跑。

R04/R07 的真实分支在 Codex 与 DSH 各用一段中等长度的真实对话：几百条、按 50 条一页至少能翻 3 页，含工具调用与图片（用户上传图片，以及正文引用的工作区图片）。可让 Agent 分批执行几十条简短只读命令来累积条目。R04 从最新页连续读到首条用户消息再回到最新，核对条目顺序、工具组与图片完整，且翻页期间原生会话未被为读取而唤醒（Codex 无为读历史发起的 `thread/resume`，DSH 旧页只走 `session/page`）。R07 在 Agent 正在执行一长串命令时按 Doctor 停止本次应用、等待原生继续产生条目，再以相同数据目录重启并打开原对话：首屏为最新、状态由原生执行事实决定、向上能连续读到停机前的内容。真实模型条目数由模型决定，记录实际条数与页数，不把替身的 5,000 条换算成真实证据。

R06 的真实 Codex Host 分支按下面的独立判据执行；使用同一应用、数据目录和对话，给本次模型/环境确定并记录等待预算：

1. 先按共同 Native 入口建立受限的自有 Host 与标准应用；通过页面启动 gate，独立核对真实 Host/socket owner、gate PID/cwd、已接受操作、原生身份及当前 run。另建一段可从侧栏切换的合成对话。第二个独立登录端完整装载同一运行对话、不注入故障，只观察主区的自然更新；不能仅凭侧栏变化判主区通过。
2. 安装共同 browser-faults，hold 当前运行对话的 GET 快照；确认 `held` 已捕获真实响应，再 SIGKILL 本次 Host（保留应用）。独立核对 Host 退出、socket 无 owner、应用端口和登录仍正常。
3. 通过独立同源读回确认对话 `unknown / configurationVerified=false`；保存原 runId、最后已知待处理数、绑定和历史，确认没有第二次派发。无注入端应在不刷新/重连/切换的情况下自动显示“待核实”并禁止新发，记录观察时间。注入端由侧栏切走再切回，使新一代读取真正到达“待核实”，新文本不可发送；不要只改 hash。
4. 释放失联前的旧 running 响应，确认页面/公共快照仍待核实，旧响应未复活 running/verified。保留 held、新状态到达、release 和最终状态的顺序；restore 后才能安装下一故障。
5. 再 hold 一份失联期间的旧 unknown 响应，确认已捕获。对残留 gate 单独按归属释放/确认退出；使用相同账号/临时权限、工作区与连接地址重启自己的 Host，核对实际新 owner。应用沿原绑定重新核实；从侧栏切走/切回，等真实新状态与配置核实完成。
6. 释放旧 unknown 响应，页面不能退回旧状态；独立原生历史/配置与公共快照均保持同一身份、原操作和确切轮次结果，无替代对话或重派。记录实际新终态，不预先把断连等同于 interrupted 或工具退出。

浏览器交错场景覆盖快照响应；后端旧连接/旧读取的成功与失败隔离另由 [组合回归](../../test/codex-workbench.test.ts) 和 [Workbench 回归](../../test/workbench.test.ts) 保护，不能相互替代。缺少可独立控制的 Host、有效权限边界或故障工具时，明确子断言 `BLOCKED`。

## Gotchas

- 关页不取消任务；但未提交草稿只在当前标签页，不承诺关页后恢复，也不跨设备同步。
- 地址恢复与页内 hash-only 导航的当前限制见 [共同入口](README.md)；使用侧栏或完整装载目标地址。
- “回到最新内容”只在最新端的页已离开窗口时出现；普通加载几页更早历史不出现。
- 历史每次都从原生读取：应用重启不改变看到的历史；原生不可用时只能看到当前页面已经加载的内容，不提供离线阅读旧历史。
- 应用启动只急切恢复最近一组对话，其他对话在打开时恢复；不能仅看启动瞬间侧栏状态判失败。
- 中书重启、浏览器离线、原生连接断开、真实 Host 崩溃是四种实验。历史可读不等于原生执行仍继续。
- Host 崩溃后先独立观察断连状态降级/禁止新发，再重启验证原身份恢复。后者通过不能补写前者通过；socket 已失效却仍显示已核实运行，应单列失败。
- 停机缺口和超长历史不再导致待核实；待核实只来自原生执行状态无法核实（断连、未知回执等）。原生改写历史（压缩替换、回退）时以原生当前视图为准。
- 工具组及每项命令/结果默认折叠；查看完整内容需逐层展开。fixture 历史样本只覆盖文本阅读；图文、引用与真实工具显示归 [U01–U10](conversation-usability.md)。

## Implementation and regression

- 页面时序/窗口/阅读锚点：[workbench.tsx](../../src/web/workbench.tsx)；标签页草稿：[workbench-client.ts](../../src/web/workbench-client.ts)。
- 浏览器窗口（分页、去重、拼接最新页、两端丢页与读回）：[history-window.ts](../../src/web/history-window.ts)。
- 最新页与实时条目（仅内存）、原生分页与游标绑定、按字节缩页：[workbench.ts](../../src/server/workbench.ts)；操作/水位/本轮文件：[workbench-store.ts](../../src/server/workbench-store.ts)。原生读取：[Codex](../../src/harness/codex/index.ts)（不 resume，按大小调整每次条数）、[DSH](../../src/harness/dsh/index.ts)（旧页只用 `session/page`，轮次由游标推算）。
- 公共分页/有界 SSE：[workbench-http.ts](../../src/server/workbench-http.ts)；契约：[shared/workbench.ts](../../src/shared/workbench.ts)。
- `node --test test/history-window.test.ts test/live-items.test.ts test/snapshot-merge.test.ts test/codex-workbench.test.ts test/workbench-store.test.ts test/workbench.test.ts test/workbench-http.test.ts`：覆盖实时帧的追加、漏帧与快照重放（[ADR 0019](../adr/0019-live-deltas-and-pure-reads.md)），重读未变历史不产生变化，只动状态的变化只合并状态、迟到的完整快照不覆盖较新状态（[ADR 0020](../adr/0020-state-only-refresh.md)）；覆盖 10 万条窗口往返、最新页拼接与缺口、任意大缺口直接接上最新页、游标绑定、空页跳过与按字节缩页、真实 RPC/adapter 失联保留最后已知事实、旧连接/迟到读取隔离、SIGKILL 后未知派发、SSE 水位重置、慢端背压与连接回收。协议 peer 是替身；这些不证明真实 Host/模型或 R03–R07 的浏览器状态。
