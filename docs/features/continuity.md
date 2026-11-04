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
| R07 | 巨型正文有限预览、完整分页/复制/下载；实时前缀不冒充完整正文 |
| R08 | 不翻阅的历史也后台存档，恢复沿持久检查点继续，覆盖缺口可见 |

## How to get to it (user POV)

侧栏选择对话，或打开带该对话 hash 的地址。“重新连接”刷新当前快照和目录；历史顶部“查看更早的内容”；进入旧窗口后“回到最新内容”；滚离底部后新输出显示“↓ 有新内容”。长条目下的“阅读完整正文/输入/输出/引用”打开完整阅读器。工作区文件阅读另见[文件地图](workspace-files.md)。

## Driving it with Harness

按 [共同入口](README.md) 建 fixture；先用 E01 建立有已知内容与身份的对话。关闭/重开必须复用本次浏览器上下文，另一个独立上下文用于检验服务端读回。每次保存 hash、fixture 原生 ID、operation ID 和条目 ID/正文。

| 场景 | 初始条件与动作 | 判据和反例 |
| --- | --- | --- |
| R01 | 在“离开恢复”发消息，确认 inspect 已调用一次且 running；关闭该页，CLI complete，再在同一上下文新页打开原 URL；B 另开新页或完整刷新原 URL | 两端均读到同一用户条目和完整完成正文，原生身份相同、submitCalls 仍为 1。关页之后才执行 complete，避免把关闭前已完成误认为离开期间完成 |
| R02 | 在“中断恢复”发消息，确认 running；按共同 Doctor 核对本次实际应用/监听 PID 后 SIGKILL；确认进程与端口均不存在，再由独立 CLI complete。以相同 root/port 启动并确认新监听者，重新打开原 hash | 同一原生 ID、同一 operation ID，accepted 与终态被核实，用户/助手正文各一份，submitCalls=1。只杀 Node 启动器、旧应用仍监听不能通过；fixture 原生状态在独立数据库，这只证明应用对边界持久状态的恢复 |
| R03 | 当前页 A 输入独有草稿但不发送，切换另一对话再回来，刷新；在独立端 B 打开相同 hash；A 退出后重新登录 | A 切换/刷新后草稿逐字相同，B 无此草稿；A 明确退出后草稿清空。pending 发送的保留与核对另跑 E02。新标签/关页后的 sessionStorage 生命周期不作为持久化承诺 |
| R04 | 新建空“短历史”，seed 650 条；等后台补齐后逐次“查看更早的内容”，读取到 0000 后返回最新。另建“长正文”，seed 150 条、每条 50,000 字符后同样读取 | 初始末条 0649/0149；对话快照合计最多 50 条、256 KiB，每条正文合计预览至多 8 KiB，完整性按 R07 验证。分页能到 0000，跨页无跳过或重复。旧页显示“回到最新内容”，返回后末条恢复。记录视口附近实际挂载行、占位高度、DOM、键入响应和滚动锚点，不能只统计数据库行 |
| R05 | 创建标题/内容不同的 A、B；用故障工具捕获 A 的下一次 GET 快照，切 B 后再释放。另在运行中的 A 捕获旧快照，切 B，CLI complete A，再从侧栏切回 A，等新正文到达后释放旧响应 | 第一分支仍显示 B 标题/正文/hash，不混入 A；第二分支仍显示完成正文/终态。切走/切回使新一代读取能越过被挂起的旧请求；同一视图的读取会合并，不能等一个被合并的请求自行超车。必须先确认 held 捕获、后观察新状态、再 release |
| R06 | 对已有正文的“断连恢复”执行 disconnect，等产品 unknown；尝试发送，再 reconnect 并“查询原生结果”/“重新连接” | 断连时正文保留、显示待核实且新文本不派发；恢复后原生身份与历史保持，submitCalls 不变，状态核实后可发。fixture 的断连不是实际 Host 崩溃，不能宣称原生进程恢复 |

```sh
node test/support/feature-fixture.ts seed --root "$zh_verify_root" --title '短历史' --count 650 --chars 80
node test/support/feature-fixture.ts seed --root "$zh_verify_root" --title '长正文' --count 150 --chars 50000
node test/support/feature-fixture.ts disconnect --root "$zh_verify_root" --title '断连恢复'
node test/support/feature-fixture.ts reconnect --root "$zh_verify_root" --title '断连恢复'
```

seed 仅允许没有消息和既有历史的 fixture 对话，不写产品历史表。每条已知正文是 `HISTORY NNNN ` 右补 `x` 到指定字符数，预期直接由输入条件确定。R04 的 `.message-text` 是预览；不能用其长度当原文长度。R07 通过完整阅读器或下载逐字核对原文，这属于结果观察，不通过内部写入制造成功。

### R07：完整正文与复杂内容

在 R04“长正文”中，打开完整正文，核对页数、前后页和最后字符；关闭后焦点与历史位置保留。在一次明确点击中复制全文，读取本次剪贴板并核对 50,000 字符；下载全文，独立核对字节长度及 SHA-256。取消复制、关掉阅读器和临时断网后重试分别验证，不将只有 HTTP 200 当完整性证据。未登录正文请求必须拒绝，改成另一对话/条目/版本也不能读到该正文。

更大的中文、emoji、代码和 HTML 样本使用独立、可销毁的规模 fixture：先按共同入口启动并初始化，用下面的 API 脚本建立空对话；确认自己的应用已经退出，再离线种入**产品存档合成数据**，随后以原 root/port 启动。这条路径证明产品查询/阅读/导航，不证明原生存档。`--total-items` 可增加全库规模而保持单对话当前工作量。

```sh
node test/support/performance-fixture-init.ts --root "$zh_verify_root" --port 4391
# 按 Doctor 确认本次应用已停止后执行：
node test/support/performance-corpus.ts --root "$zh_verify_root" --items 60000 --total-items 1000000 --conversations 10001 --workspaces 300 --files 10000
```

`corpus.json` 记录对话 ID、独立生成的预期摘要与巨型正文长度。打开该地址，预览中的 `<script>` 只能作为文字；完整阅读器跨 64 KiB 边界不产生乱码或丢字。导出内容与 `corpusItem()` 生成的原文独立比较。用自己新建的 Chromium profile 开启调试端口后，可运行 `node test/support/performance-browser.ts --root "$zh_verify_root" --port 4391 --browser <自有调试端口> --output <仓库外绝对JSON路径>`；该入口只接回环端口，创建并关闭自己的页，不接管个人浏览器。脚本记录延迟/DOM/堆及前两页内容，复制、下载、长距离滚动和手机路径仍要另行驱动。数值预算唯一见[测量配置](../../test/support/performance-profile.ts)。

### R08：离页补齐与故障

新建空“后台存档”，记录对话 ID 后切去另一段对话，再用 seed 加 650 条已知内容。保持页面不打开这段历史，不调用 older。用只读 SQLite 查询核对该对话 `workbench_items` 的 650 个稳定 ID 和正文；记录 latest/backfill 的持久检查点、完成与错误。只读观察不能修改行或检查点。随后从浏览器打开、翻到 0000 并核对末条。页面的“最近同步”表示已确认时点，不能推断源在此后没有变化。

另建样本，在页导入中 SIGKILL 本次应用；按 Doctor 确认退出后重启，核对已经完成的正文没有再次导入、检查点继续前进、全部 ID/摘要最终一致。源文件被替换、游标失效或源内容缺失时，保留旧档，页面明确显示连续性未确认或来源缺口；一次新扫描成功不能清掉旧缺口。实时条目标记“完整内容正在存档”期间不得出现针对截断前缀的完整正文链接；持久终态到达后才有可独立核对的全文。原生版本、物理读源和大量离线条目用下方原生分支另证，不用 fixture 推断。

旧条目修订须单独构造：先存档至少 35 条已完成消息，再在原生源末尾修订最早的两条，修订顺序与历史顺序相反。不要打开旧页，等后台变更水位推进后核对新正文、原有历史顺序和旧摘要正文均可读取；短正文、空正文及巨型正文各覆盖一例。中途杀应用再恢复，正文和水位不能出现只提交一方。只读观察 `workbench_archive_updates`，并核对公开“完整”状态不会在变更页尚未完成时提前成立。原生替身缺少变更流时须显示 `archive_updates_unavailable`，不能拿一次头页成功代替旧条目覆盖。事务、迟到页和真实 worker 重启入口见 [修订回归](../../test/archive-updates.test.ts)。

修订积压超过一页时，后台续页应直接推进变更水位，不为每批旧修订重复提取同一巨型头页。强制同步仍读取新头；出现尚未进入历史的 ID 或源游标失效时，必须回到历史路径恢复，不能跳过对应变更。用 `node --test --test-name-pattern='change-feed' test/workbench.test.ts` 同时验证调用量和恢复分支。

按 [W03](workspace-management.md) 移除工作区后，再向已授权的同一物理源追加未读正文；保持工作区移除，等待归档并通过原对话全文接口核对。发送和原文件接口仍须拒绝；后台不得启动原生执行或任意读取已移除目录中的图片路径。目录被替换或绑定变化时暂停新读取，旧档仍在。

联合持续运行使用 R07 的可销毁规模现场。固定源码副本和已通过 `check:release` 的构建目录；应用运行时不要重建其 `dist` 或替换源码，worker 也必须使用同一版本。以 `feature-fixture.ts serve --root "$zh_verify_root" --port 4391 --build <固定构建绝对目录> --physical` 启动：两个独立原生格式源各含 20,000 条消息，实际物理 reader 和产品后台泵负责导入；执行/state/watch 仍是明确替身。每 30 秒把进程内存、event loop、storage 队列与失败分类、数据库/WAL 大小、归档检查点及独立源清单摘要写入私有 `performance-service.ndjson`，每十次采样给两个源各追加 100 条。永久正文不通过测试脚本直接写入。

在自己拥有的 Chromium 调试 profile 上运行 `node test/support/performance-soak.ts --root "$zh_verify_root" --port 4391 --browser <自有调试端口> --output <新建仓库外NDJSON绝对路径> --seconds 86400`。客户端持续发送/停止两种合成执行、读取历史和正文块、刷新和翻阅目录、搜索元数据、保持两个 SSE 客户端（其中一个延迟读取），并在 4 倍 CPU 节流、80 ms/10 Mbps 下实测页面首屏和键入。`--seconds 300` 只用于先验证装配，不能代替 24 小时。浏览器客户端放在应用资源限额之外；Linux 应用及其 workers 共用测量配置的 2 CPU/4 GiB，原生执行 Host 另计。本入口没有证明真实 Harness 模型执行或编辑保存，这些仍需执行地图的受管原生分支。

保存源码/构建清单、容器约束、客户端 NDJSON/summary 和服务端采样；独立确认计时完整、无失败、每项阈值符合测量配置，并检查归档检查点持续前进及最终内容全集。脚本退出码不能代替 RSS/WAL/缓存曲线和原生源完整性核对。中断、worker 退出或字节不一致都保留原失败；定位修复后用新的固定候选重新运行。取消时只向自己拥有的客户端/应用发停止信号，等待清理完成。

24 小时结束后，先按本现场的停止步骤关闭应用并确认 `app.lock` 已消失，再用相同代码位置和迁移版本运行离线核验。输出父目录须为自己拥有的私有目录，输出文件必须不存在且位于 fixture root 外；脚本拒绝升级或修改不匹配的数据库结构。

```sh
node test/support/performance-archive-audit.ts --root "$zh_verify_root" --output <新建仓库外JSON绝对路径> --seconds 3600
```

该入口读取两个 `physical-*/state.json`、`expected.ndjson` 和私有对话身份文件，将期望清单流式放入自有临时 SQLite 索引；通过真实 storage worker 每页最多 100 条、正文每块最多 64 KiB 核对完整 SHA-256、字节数、稳定 ID、顺序、重复和缺项。关闭 worker 后重新启动再核验一次，源文件起止身份/指纹及产品库 `data_version` 必须不变。报告保留原始归档任务检查点；`complete` 表示清单内容全集完整，不覆盖任务原有 `complete/error/working` 字段。当前物理 factory 只有文本预期，图片、工具或文件形状若意外出现会失败，不会宣称已核验这些额外资源。

默认且唯一模式不补齐：不启动 Workbench、原生 reader 或归档泵。缺项、正文/顺序差异和仍存在的 app.lock 均退出非零，原源和产品库保留；临时期望索引会清理。若结束时缺项，先保存这份失败报告，再显式启动补齐流程、停止后用另一个输出文件复验；补齐后的通过不能替换结束时失败。

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
- 存档失败、原生源缺口与执行待核实是独立状态；已存正文仍可读，覆盖未确认不能改写成“完整恢复”。受管 Host 完全关闭时，容器内物理 reader 也可能暂不可达，存档暂停后恢复，不假报完整。
- 工具组及每项命令/结果默认折叠；查看完整内容需逐层展开。fixture 历史样本只覆盖文本阅读；图文、引用与真实工具显示归 [U01–U10](conversation-usability.md)。

## Implementation and regression

- 页面时序/窗口/阅读锚点：[workbench.tsx](../../src/web/workbench.tsx)；标签页草稿：[workbench-client.ts](../../src/web/workbench-client.ts)。
- 持久投影/操作/水位：[workbench-store.ts](../../src/server/workbench-store.ts)、[migrations.ts](../../src/server/migrations.ts)；恢复与补齐：[workbench.ts](../../src/server/workbench.ts)。
- 公共分页/有界 SSE：[workbench-http.ts](../../src/server/workbench-http.ts)；契约：[shared/workbench.ts](../../src/shared/workbench.ts)。
- 不可变正文/分块/暂存：[body-store](../../src/server/body-store.ts)、[body-reader](../../src/web/body-reader.tsx)；`node --test test/body-store.test.ts test/archive-checkpoint.test.ts test/archive-updates.test.ts test/history-order.test.ts` 保护正文、检查点和位置索引恢复。
- `node --test test/codex-workbench.test.ts test/workbench-store.test.ts test/workbench.test.ts test/workbench-http.test.ts`：覆盖真实 RPC/adapter 失联落库、失败重连不重复失效、旧连接/迟到读取隔离、SIGKILL 后未知派发、历史补齐预算、SSE 水位重置、慢端背压与连接回收。协议 peer 是替身；这些不证明真实 Host/模型或 R03–R05 的浏览器状态。

### 原生有界读取复验

先按 [共同入口](README.md) 建立独立、可销毁的原生 Host。只使用合成工作区、独立原生 HOME 与本次测试的连接信息。以下固定格式兼容层不读取凭据，不修改个人安装源；读历史也不代表核实了执行状态。

- Codex 兼容层固定 `0.166.0-alpha.5.1` 的 `paginated` rollout。`boundedHistory.nativeRoot` 指向专用 `CODEX_HOME`，`cacheRoot` 必须是它之外的独占缓存目录。原生 `thread/read(includeTurns:false)` 只提供绑定的 rollout 路径和版本，worker 再核对 `session_meta` 的线程、工作区、版本及连续 `ordinal`。`history`、`readItems` 不得出现 `thread/resume` 或 `thread/items/list`；执行侧的 `state/watch/reconcile` 仍需要 Host 的激活许可。
- DSH 兼容层固定 `0.2.1-rc.4` 的 v4 JSONL 或带校验和的 Zstandard frame。默认原生目录是 `$DSH_HOME/sessions`，其下才是编码后的工作区和 session 目录；覆写原生 `sessions.config.root` 时以该目录为准。`boundedHistory.nativeRoot`、`cacheRoot` 同样分开。原生格式、根目录与拒绝行为由 [reader 回归](../../test/dsh-bounded-reader.test.ts) 保护。
- DSH 的有界状态出口另外要求受管专用 Host 禁用 `session-turn-outline`，用 Cordis 的 `insert` 插入构建产物 `harness/dsh/bounded-host-plugin.js`，配置 `runtimeRoot` 为固定版本包安装目录；适配器启用 `boundedState`。插件版本不匹配、旧 outline 未关闭、终态证据缺失都不得伪造 idle。旧终态以物理索引提供候选 seq，并由当前原生 Session 核对。插件 `state/follow` 会解析或恢复原生 Agent，不能用于绕过执行围栏的“只读”核验。
- 两端受管适配器启用 `managedExecution`。断线只撤销可信观察；没有新的许可，后台重连不得恢复原生会话。检查见 [Codex](../../test/codex.test.ts) 与 [DSH](../../test/dsh.test.ts) 的 managed observation loss 分支。

跨层入口 [native-archive-verify](../../test/support/native-archive-verify.ts) 生成固定原生物理格式，调用真实读取器、Workbench 的后台归档操作、独立存储 worker，最后逐项读取已发布正文，与生成时独立记录的 ID、顺序、字节数及 SHA-256 全集核对。它只预置产品对话绑定，不预置产品历史或正文；Codex 的路径元数据 IPC 是受限 fixture，拒绝执行方法，DSH 直接离线读取。计时不含后台定时器的等待，不应解释为生产吞吐或真实模型生成成本。

```sh
node test/support/native-archive-verify.ts --harness codex --count 20000 --gap 2001 --report /absolute/operator-output/codex-archive.json
node test/support/native-archive-verify.ts --harness dsh --count 20000 --gap 2001 --report /absolute/operator-output/dsh-archive.json
node test/support/native-archive-verify.ts --harness dsh --dsh-compressed --count 20000 --gap 2001 --report /absolute/operator-output/dsh-compressed-archive.json
```

顺序运行，先确认上一项退出并清理。每次先补齐 20,000 条原生消息，再停止应用、离线追加 2,001 条、复用产品数据与绑定重启，最后再次重启读完整集合。语料包含 UTF-8、超过预览上限的正文与超过单次归档字节预算的正文。额外文件条目必须出现在本轮文件索引；Codex 原生图片条目必须成为可读取的产品图片资源且字节 hash 一致，不能把 fallback 提示当作图片通过。任一缺失、重复、错序、错误 SHA、未完成 checkpoint、图片或文件断言失败，入口都以非零退出并输出 `FAIL`；报告明确区分 DSH 当前没有对应原生图片条目映射。小集合持续回归见 [native-archive-readers.test.ts](../../test/native-archive-readers.test.ts)。

`--keep-failure` 保留失败合成目录，并在报告记录首个 storage worker 故障类别、可获取的退出码和 worker heap/external 采样；不应把后续 `storage_unavailable` 猜成 OOM。报告还记录每次重启时的源码指纹。Codex 不超过 4 KiB 的完整纯文本直接随页归档，空正文不生成零字节暂存 token；超过预算或混合内容仍走全文分块路径。失败图片与超过 100 个路径的 FileChange 也须归档成功，文件路径只做有限投影并显式标记，完整原生 JSON 和 diff 保留在正文中。

联合 HTTP/目录负载使用 [createPhysicalArchiveFixture](../../test/support/native-archive-fixture.ts)：传独占私有 `root`、规范化 `cwd`、`harness`、`bindingId` 与初始 `count`，保存返回的完整 `binding`，把 `reads` 接到专用只读会话；`appendGap(n)` 持久追加且重开不重置，`manifest()` 返回独立预期全集的文件和 hash。执行、状态与观察仍由调用方明确标为合成，该工厂不证明真实原生执行。它不向产品历史表直接插入条目。

真实 Host 复验另外执行：从隔离本地协议模型产生超过 32 MiB 的 Codex 回复，用 `optOutNotificationMethods` 抑制完整条目/轮次通知，检查仍有有限实时预览、无完整正文伪装成预览、原生终态可核实；停止 Host 后按块读回全文，重启后续用旧 cursor 与精确 `readItems`，逐字节核对预期 SHA。文件、图片、Plan、Reasoning、MCP 与动态工具须使用固定版本实际接受的持久化形状；合成原生记录只证明解析和产品归档，不证明模型真的编辑过文件或生成过图片，后者仍按 [会话可用性 U03/U05](conversation-usability.md) 独立执行。

代次和缓存反例：替换原生日志后旧 cursor 应失效，已发布中书正文保持可读；仍持有租约的旧正文在释放前保持版本不变。不断增加绑定/代次使原生源总量超过兼容缓存预算，缓存应回收可重建索引及临时正文，旧源仍可按需重建和归档；租约占满时须明确暂停，释放后可恢复。不能删除中书永久存档来通过。对应 [Codex](../../test/codex-bounded-reader.test.ts)、[DSH](../../test/dsh-bounded-reader.test.ts) 与 [状态投影](../../test/dsh-bounded-state.test.ts) 的反例覆盖必须一并通过。

DSH 的迁移可能把多年事件写入单个 Zstandard frame。索引扫描同时生成受同一全局 quota 约束、可校验和重建的 256 KiB 解压块；常驻内存最多四块。复验需构造单 frame 20,001 事件，重启后随机旧页的 `cacheStatus().frameReads` 不得新增 frame 解码；原生源超过缓存预算时，冷旧窗口应共享一次重建，不得每条消息从 frame 开头重解压。缓存损坏应从未改动的原生源重建，同大小原生改写则拒绝。冷缓存重建仍可能扫描原生压缩 frame，不能把首次随机读取宣称为常数时间。

增量索引一次处理普通 JSONL 约 8 MiB 或最多 8 个压缩 frame。压缩 frame 必须完整通过 CRC 校验才发布其索引，单个巨型 frame 可以超过 8 MiB，因此没有严格每次调用 8 MiB 或固定耗时的保证。冷扫描仍由独立 worker 流式执行并受内存和缓存配额约束；热页的点查成本不能外推到首次冷扫描。DSH 每条目的最新事件按类型取 seq，再以复合键读取记录；[reader 回归](../../test/dsh-bounded-reader.test.ts)分别增加源条目数与同条目修订数，核对每页实际索引访问不随二者线性增长。

边界仍须如实报告：兼容层不使原生 Host 的模型上下文和冷恢复内存成为常数；DSH 原生 `userQuestions.settled` 的历史增长也未由状态出口消除。单个工作索引和正文暂存仍受操作者缓存容量约束，容量不足会暂停完整性推进，不能静默截断或把预览标成完整正文。
