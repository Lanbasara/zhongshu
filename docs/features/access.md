# 私人入口：feature map

当前能力：单管理员初始化后登录、刷新/普通应用重启保留有效身份、当前端退出、密码重置后全部失效。决策归 [ADR 0006](../adr/0006-auth-session-data.md)。通用管理员命令属于产品能力，见 [admin.ts](../../src/server/admin.ts)；生产实例位置与凭据由操作者维护。

## Sub-features

| 场景 | 要证明的行为 |
| --- | --- |
| A01 | 未初始化时没有密码登录入口；CLI 初始化后可以登录 |
| A02 | 错误密码拒绝；正确登录后刷新与普通应用重启保持身份 |
| A03 | 两端身份独立；退出 A 不影响 B，A 私有读取与 SSE 失效 |
| A04 | CLI 重置密码后，两端旧身份都失效 |
| A05 | 旧 session 响应不能覆盖刚完成的登录或退出 |

## How to get to it (user POV)

打开本次 origin →“登录中书”→“管理员密码”→“进入工作台”。已登录时侧栏“退出登录”。未初始化时显示“管理员尚未完成初始化。完成后即可登录。”；没有浏览器注册、初始化或重置密码入口。

## Driving it with Harness

本页无需真实 Harness。先按 [共同入口](README.md) 启动 fixture，**A01 之前不要运行 init**。使用两个独立浏览器上下文 A/B。

| 场景 | 初始条件与动作 | 必须观察；如何识别失败 |
| --- | --- | --- |
| A01 | 新 root 启动，打开页面；另一个终端运行 `node test/support/feature-fixture.ts init --root "$zh_verify_root"`，刷新页面并登录 | 初始化前只有说明、没有密码输入；之后出现密码字段并能进入工作台。服务 ready 或初始化命令成功不能替代页面结果 |
| A02 | 若接着 A01 运行，先明确退出回到登录页；输入一次错误密码，再输入私密文件中的随机密码；刷新；停止本次应用并用相同 root/port 重启，再刷新 | 错误密码显示“密码不正确，请重试。”，仍在登录页；正确密码出现工作台。刷新/普通重启后仍可读取私有目录；另用全新上下文打开应仍需登录 |
| A03 | B 单独登录；两个页面均建立更新流。在 A 点退出，再刷新 A；在 B 打开新对话框 | A 回到登录页，A 的同源 `fetch('/api/private/identity')` 状态为 401；原 SSE 结束且不再收到私有 change。B 仍能打开目录，私有 identity 为 200。两个普通标签共享 Cookie，不是两个独立端 |
| A04 | A/B 重新独立登录并连上 SSE；终端运行下面的 reset 命令 | 两条旧流在下次鉴权时结束（默认心跳上限约 15 秒；条件等待上限 20 秒），两端刷新均回登录页，旧私有 identity 为 401。新随机密码能重新登录；不使用真实实例 reset |
| A05 | 安装共同入口的浏览器故障工具；用以下步骤分别制造登录和退出前的旧 session 查询 | 旧响应释放后页面仍保持刚完成的身份；同时私有 identity 状态与页面一致。记录 `held` 的捕获条件，否则没有证明竞态 |

```sh
node test/support/feature-fixture.ts reset --root "$zh_verify_root"
```

A05 的登录分支：在已初始化的未登录页执行 `zhVerify.holdNext('/api/session')`，触发 `window.dispatchEvent(new Event('pageshow'))`；等待 `zhVerify.status().held === '/api/session'`，再通过密码字段登录。进入工作台后执行 `zhVerify.release()`，页面不能退回登录页。退出分支：在已登录页按同样方法捕获旧 session，再点退出、等待登录页、释放旧响应；页面不能恢复工作台。故障工具忽略被测读请求的取消信号，只让真实旧响应迟到，不伪造身份数据。结束执行 `zhVerify.restore()`。

SSE 观察在浏览器网络面板或自动化的 EventSource 事件记录中进行；保存状态码、打开/关闭时间和合成 change 的数量，不保存请求 Cookie。没有流观察能力时，该子断言单列 `BLOCKED`，不以页面刷新成功替代。

## Gotchas

- 页面收到 401 才会退出旧视图；CLI 重置后不能要求页面在零延迟内主动消失。
- 退出只吊销当前会话；重置或恢复备份才使全部旧身份失效。
- 登录会轮换当前 Cookie；另一个共享 Cookie 的标签页不是独立会话。
- 退出清除当前标签页草稿；会话失效不会承诺跨端草稿同步。
- 绝对过期、持久限速、备份恢复与恢复后会话吊销由下方回归覆盖；这里的普通刷新不是这些分支的证据。
- 产品库恢复同时关闭受管执行门禁、保留原窗口与未知保存，并要求重新核实原生效果。独立 Host ledger 和文件写者 owner/journal 不随产品库回滚或换目录；备份里的旧 idle 不能证明当前 Host 已停止。文件写者重启恢复与复验归[工作区文件](workspace-files.md)。
- 配额覆盖产品目录内数据库、WAL 与缓存，真实磁盘余量另设门禁；接近上限告警、满额拒绝新增工作和上传，已有存档保留，已受理任务不因此取消。正文导入先预约完整体积，既有阶段在预约内续传；未知阶段不按超时删除。只有同一原生来源的更晚版本成功发布后，才分批回收可比较的旧暂存。已经发布的任何正文版本都不在自动回收范围。扩容或释放空间后通过回差恢复准入。
- 明确拒绝或已有执行终态证明的旧操作可无损压缩输入，操作编号、原摘要、回执和资源引用永久保留；同编号同内容仍读回原结果，改内容拒绝。未知或运行中的输入不压缩，短条和不能节省空间的输入保留原文。旧记录按一次性持久检查点扫描，新候选同业务事务登记；释放的 SQLite 页供后续复用，不承诺文件立即缩小。

## Implementation and regression

- 页面身份时序：[main.tsx](../../src/web/main.tsx)；HTTP/Cookie/来源/CSRF：[app.ts](../../src/server/app.ts)。
- 认证、到期与限速：[auth.ts](../../src/server/auth.ts)；可信 CLI：[admin.ts](../../src/server/admin.ts)；数据库：[database.ts](../../src/server/database.ts)。
- `node --test test/auth.test.ts test/http.test.ts test/workbench-http.test.ts`：包含双端/重置/绝对过期、真实 HTTP/SSE 吊销。A05 需要上述页面时序，现有服务端测试不替代它。
- 容器中的 CLI 备份/恢复、Cookie 与替换后身份：构建后按 [README](../../README.md#container) 使用 [check-container.mjs](../../scripts/check-container.mjs)，仅针对本次新建 Compose 项目。
- `node --test test/execution-store.test.ts test/execution-workspaces.test.ts test/workspace-writer.test.ts` 覆盖超过 10,000 段未决对话的真实备份恢复、执行日志保留、真实文件写者强杀和重启核实；原生执行部分使用明确替身，真实 Host 收束另验。
- `node --test test/storage-capacity.test.ts test/body-store.test.ts` 覆盖配额、缓存/WAL 计量、有界上传与正文回收、未知阶段保全、并发旧页和异源版本不能误退役、预约内续传及扩容恢复。Linux 实际磁盘耗尽入口为 `node test/support/storage-enospc.ts /space`；只接受不超过 128 MiB 的一次性 tmpfs，推荐隔离容器提供 32 MiB 挂载。它实际分配至 ENOSPC、固定 WAL 读者，并用耗尽前的样本模拟 statfs 与提交之间的抢盘竞态，核对未提交条目、旧正文、操作身份、释放空间和重开后的完整性；不证明浏览器或原生 Harness。
- `node --test test/operation-payload-store.test.ts` 覆盖终态压缩资格、原样重试、摘要损坏关闭读取、队列摘要、单调检查点，以及 schema 10 备份迁移、压缩后再次备份恢复的正文/图片 SHA、原操作身份、原生绑定和会话吊销。
