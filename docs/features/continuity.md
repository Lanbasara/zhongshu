# 接续与阅读：feature map

当前能力：恢复同一对话、当前标签页保留草稿/未确认发送、读取更早历史与处理晚到响应。持久化和恢复语义见 [ADR 0003](../adr/0003-local-persistence.md)、[ADR 0004](../adr/0004-recoverable-communication.md)。

## Sub-features

| 场景 | 要证明的行为 |
| --- | --- |
| R01 | 关页后工作不被浏览器取消；重开同一地址能读回结果 |
| R02 | 中书进程中断后保留绑定和操作，核对原生结果，不盲目重派 |
| R03 | 草稿按对话保存在当前标签页，支持刷新/切换；独立端不共享 |
| R04 | 完整分页读取历史；超过窗口时只保留有界页面，并能回到最新 |
| R05 | 旧对话/旧版本快照不能覆盖当前页面和较新结果 |
| R06 | 原生断连时保留历史、阻止新发；恢复后沿原身份核对 |

## How to get to it (user POV)

侧栏选择对话，或打开带该对话 hash 的地址。“重新连接”刷新当前快照和目录；历史顶部“查看更早的内容”；进入旧窗口后“回到最新内容”；滚离底部后新输出显示“↓ 有新内容”。没有成果文件阅读器；这里阅读的是对话正文和可展开的工具组。

## Driving it with Harness

按 [共同入口](README.md) 建 fixture；先用 E01 建立有已知内容与身份的对话。关闭/重开必须复用本次浏览器上下文，另一个独立上下文用于检验服务端读回。每次保存 hash、fixture 原生 ID、operation ID 和条目 ID/正文。

| 场景 | 初始条件与动作 | 判据和反例 |
| --- | --- | --- |
| R01 | 在“离开恢复”发消息，确认 inspect 已调用一次且 running；关闭该页，CLI complete，再在同一上下文新页打开原 URL；B 另开新页或完整刷新原 URL | 两端均读到同一用户条目和完整完成正文，原生身份相同、submitCalls 仍为 1。关页之后才执行 complete，避免把关闭前已完成误认为离开期间完成 |
| R02 | 在“中断恢复”发消息，确认 running；按共同 Doctor 核对本次实际应用/监听 PID 后 SIGKILL；确认进程与端口均不存在，再由独立 CLI complete。以相同 root/port 启动并确认新监听者，重新打开原 hash | 同一原生 ID、同一 operation ID，accepted 与终态被核实，用户/助手正文各一份，submitCalls=1。只杀 Node 启动器、旧应用仍监听不能通过；fixture 原生状态在独立数据库，这只证明应用对边界持久状态的恢复 |
| R03 | 当前页 A 输入独有草稿但不发送，切换另一对话再回来，刷新；在独立端 B 打开相同 hash；A 退出后重新登录 | A 切换/刷新后草稿逐字相同，B 无此草稿；A 明确退出后草稿清空。pending 发送的保留与核对另跑 E02。新标签/关页后的 sessionStorage 生命周期不作为持久化承诺 |
| R04 | 新建空“短历史”，seed 650 条；点击重新连接，再逐次“查看更早的内容”，读取到 0000 后返回最新。另建“长正文”，seed 150 条、每条 50,000 字符后同样读取 | 初始末条 0649/0149；服务端每页最多 100 条，浏览器再按正文预算缩窗。分页能到 0000，不重复 ID、不丢正文尾部。超过 500 条或正文预算后显示旧页提示与“回到最新内容”，可见条目≤500，返回后末条恢复。记录 DOM 与公共快照，不能只统计数据库行 |
| R05 | 创建标题/内容不同的 A、B；用故障工具捕获 A 的下一次 GET 快照，切 B 后再释放。另在运行中的 A 捕获旧快照，切 B，CLI complete A，再从侧栏切回 A，等新正文到达后释放旧响应 | 第一分支仍显示 B 标题/正文/hash，不混入 A；第二分支仍显示完成正文/终态。切走/切回使新一代读取能越过被挂起的旧请求；同一视图的读取会合并，不能等一个被合并的请求自行超车。必须先确认 held 捕获、后观察新状态、再 release |
| R06 | 对已有正文的“断连恢复”执行 disconnect，等产品 unknown；尝试发送，再 reconnect 并“查询原生结果”/“重新连接” | 断连时正文保留、显示待核实且新文本不派发；恢复后原生身份与历史保持，submitCalls 不变，状态核实后可发。fixture 的断连不是实际 Host 崩溃，不能宣称原生进程恢复 |

```sh
node test/support/feature-fixture.ts seed --root "$zh_verify_root" --title '短历史' --count 650 --chars 80
node test/support/feature-fixture.ts seed --root "$zh_verify_root" --title '长正文' --count 150 --chars 50000
node test/support/feature-fixture.ts disconnect --root "$zh_verify_root" --title '断连恢复'
node test/support/feature-fixture.ts reconnect --root "$zh_verify_root" --title '断连恢复'
```

seed 仅允许没有消息和既有历史的 fixture 对话，不写产品历史表。每条已知正文是 `HISTORY NNNN ` 右补 `x` 到指定字符数，预期直接由输入条件确定。R04 在浏览器可用 `.message-text` 读取每条完整 `textContent`，检查长度、编号与末字符；这属于结果观察，不通过内部写入制造成功。

R05：在对应 A 页面安装 browser-faults，执行 `zhVerify.holdNext('/api/private/workbench/conversations/' + location.hash.slice(1))`，点“重新连接”，等待 held，再按表中顺序通过侧栏切换。确认新结果可见后 `release()`，等待 held 清空再检查标题、正文与快照。若页面工具无法控制该顺序，单列 `BLOCKED`；直接快速点击不等于确定覆盖。

R01/R02 的 native 分支使用 [E05 的受控 gate](execution.md)：确认真实工具已启动后关页或只停中书；从可信端确认本次 Host 与 gate 仍存活，再创建 release 文件；读回 finished 文件、重新打开同一对话。保存实际进程身份。真实 Host 单独突然崩溃需要操作者提供可销毁的独立 Host；有权限且实际完成该实验前，不能用中书进程崩溃替代。Android 后台/回收和移动网络也需在真机另跑。

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
- “回到最新内容”只在有界旧窗口状态出现，普通加载一页更早历史不一定出现该按钮。
- 应用启动只急切恢复最近一组对话，其他对话在打开时恢复；不能仅看启动瞬间侧栏状态判失败。
- 中书重启、浏览器离线、原生连接断开、真实 Host 崩溃是四种实验。历史可读不等于原生执行仍继续。
- Host 崩溃后先独立观察断连状态降级/禁止新发，再重启验证原身份恢复。后者通过不能补写前者通过；socket 已失效却仍显示已核实运行，应单列失败。
- 历史缺口、原生历史分歧或超过补齐窗口时可能明确待核实；不能把显式缺口改写成“完整恢复”。
- 工具组及每项命令/结果默认折叠；查看完整内容需逐层展开。fixture 历史样本只覆盖文本阅读；图文、引用与真实工具显示归 [U01–U10](conversation-usability.md)。

## Implementation and regression

- 页面时序/窗口/阅读锚点：[workbench.tsx](../../src/web/workbench.tsx)；标签页草稿：[workbench-client.ts](../../src/web/workbench-client.ts)。
- 持久投影/操作/水位：[workbench-store.ts](../../src/server/workbench-store.ts)、[migrations.ts](../../src/server/migrations.ts)；恢复与补齐：[workbench.ts](../../src/server/workbench.ts)。
- 公共分页/有界 SSE：[workbench-http.ts](../../src/server/workbench-http.ts)；契约：[shared/workbench.ts](../../src/shared/workbench.ts)。
- `node --test test/codex-workbench.test.ts test/workbench-store.test.ts test/workbench.test.ts test/workbench-http.test.ts`：覆盖真实 RPC/adapter 失联落库、失败重连不重复失效、旧连接/迟到读取隔离、SIGKILL 后未知派发、历史补齐预算、SSE 水位重置、慢端背压与连接回收。协议 peer 是替身；这些不证明真实 Host/模型或 R03–R05 的浏览器状态。
