# Harness 账号

决定见 [ADR 0015](../adr/0015-harness-account-status.md)。

## Sub-features

| 场景 | 可证伪的结果 |
| --- | --- |
| H01 · 状态 | 「设置 → 账户」每端一张卡片，状态与原生一致：可用、未登录、登录已失效、暂时无法核实、未连接。只有厂商这次接受了凭据才显示可用；Codex 可用时显示额度用量与重置时间。 |
| H02 · 提醒 | 某端未登录、失效或未连接时，对话区上方出现提醒，「去处理」打开「设置 → 账户」。进入未登录或失效时推送一次「X 账号需要处理」；未连接和暂时无法核实不推送。 |
| H03 · Codex 续登 | 点「登录」得到验证地址和登录码；在任意设备完成后，卡片不刷新即变为可用。可以取消；新发起会顶掉旧的；20 分钟未完成显示过期。 |
| H04 · 安全 | 未登录、缺 CSRF 的请求被拒；读取接口、日志和数据库中没有登录码；日志只记发起、成功、失败、取消、过期和需要处理。 |
| H05 · DSH | DSH 只显示状态和提醒；需要登录时说明由操作者在服务器上完成。 |

## How to get to it (user POV)

登录后点侧栏「设置」，选「账户」标签；手机上先点左上角「打开对话导航」。账号区在页面顶部，管理员信息在下方。主界面出现红色提醒时，点「去处理」也会到这里。打开这一页时，一分钟内没核实过的账号会立即核实；之后每 30 分钟自动核实一次，也可以点「重新核实」。

## Driving it with Harness

**前提。** 使用[共同入口的 Native 现场](README.md#native真实接入分支)。不要在别人正在用的 Codex 上做登录类实验：登录会替换它的凭据。

**隔离的 Codex。** 用与目标相同的 Codex 镜像，另起一个配置目录为空的 App Server。

- **未登录**：凭据为空。原生读账号得到 `account: null`；`getAuthStatus` 的 `authMethod` 为 null。
- **登录已失效**：放一份无法续期的 ChatGPT 凭据，比如伪造的未签名 id_token 加上无效的刷新令牌。原生读账号报一次“access token could not be refreshed”，之后显示为没有账号；`getAuthStatus` 仍为 `chatgpt`。读额度时返回 `401 Unauthorized`。
- **可用**：用真实账号完成设备码登录，原生 `account/read` 为 chatgpt，`account/rateLimits/read` 返回用量。

**读回。**

- 中书侧：私有 `GET /api/private/accounts`（需登录会话），`POST /api/private/accounts/<codex|dsh>/check`（需 CSRF）。
- 原生侧：Codex 用 `account/read`、`getAuthStatus`、`account/rateLimits/read`；DSH 用 `account/getState`、`account/getProfile`。
- 输出前遮盖邮箱、用户码和账号 ID。

**登录码。** 只出现在发起登录的那一次响应中。验证时可以在服务端日志里搜索登录码的格式，结果应为零。

**收尾。** 隔离实验结束后，调用 `account/logout`，删除临时配置目录和容器。

## Gotchas

- **Codex 本地有凭据不等于可用。** 读账号即使要求刷新，刷新失败也不会出现在结果里，所以要靠读额度判断。读额度返回 401 时，中书会先让原生刷新一次再读；仍是 401 才判为失效，以免把“访问令牌刚过期、刷新令牌还有效”误报为失效。
- **无法续期的 Codex 凭据只报一次错**，之后就像没有账号。所有读账号的地方都要记录这次报错。一个刚启动的进程靠 `getAuthStatus` 区分“从未登录”和“凭据还在但不能用”。失效状态一直保持到核实成功；凭据被删掉后，仍显示“登录已失效”。
- **DSH 的核实资料可能失败而推理正常。** 2026-11-07 在本机开发环境的实验授权上，`getProfile` 和 `getBalance` 都返回 failed，而推理正常、凭据没被清除，所以显示“暂时无法核实”。平台拒绝凭据时，原生会清除它，下次核实即为失效。
- **新发起的 Codex 登录会顶掉旧的**：旧的会收到 `account/login/completed {success:false}`，取消旧的返回 notFound。
- **每次应用启动后，第一次核实如果是未登录或失效，会推送一次。**

## Implementation and regression

- 接入：[Codex](../../src/harness/codex/index.ts)（读账号、额度、设备码、通知）与 [DSH](../../src/harness/dsh/index.ts)；401 与“无法刷新”在 [RPC](../../src/harness/codex/rpc.ts) 中识别。
- 核实、提醒与登录状态：[harness-accounts.ts](../../src/server/harness-accounts.ts)；视图结构：[shared/accounts.ts](../../src/shared/accounts.ts)。
- 界面：[功能层](../../src/web/harness-accounts.tsx)、[展示组件](../../src/web/patterns/harness-accounts.tsx)、[原型](../../design/stories/HarnessAccounts.stories.tsx)。
- 回归：[核实、推送、登录与接口](../../test/harness-accounts.test.ts)；Codex 与 DSH 的账号映射在 [codex.test.ts](../../test/codex.test.ts) 与 [dsh.test.ts](../../test/dsh.test.ts)。
