# Harness 账号

决定见 [ADR 0015](../adr/0015-harness-account-status.md)。

## Sub-features

| 场景 | 可证伪的结果 |
| --- | --- |
| H01 · 状态 | 「设置 → 账户」每端一张卡片，状态与原生一致：可用、未登录、登录已失效、暂时无法核实、未连接。只有厂商这次接受了凭据才显示可用；Codex 可用时显示额度用量与重置时间。 |
| H02 · 提醒 | 某端未登录、失效或未连接时，对话区上方出现提醒，「去处理」打开「设置 → 账户」。进入未登录或失效时推送一次「X 账号需要处理」；未连接和暂时无法核实不推送。 |
| H03 · 续登 | Codex：点「登录」得到验证地址和登录码；在任意设备完成后，卡片不刷新即变为可用。DSH：点「登录」得到 DeepSeek 登录页；登录后把跳转到的本机地址粘贴回来，点「完成登录」后变为可用；粘贴错的地址会提示，登录仍可继续。两端都可以取消，未完成的登录会过期。 |
| H04 · 安全 | 未登录、缺 CSRF 的请求被拒。读取接口、日志和数据库中没有登录码、登录页地址和粘贴的跳转地址；日志只记发起、成功、失败、取消、过期和需要处理。DSH 粘贴登录只把 code 和 state 交给 Host 自己的回调。 |
| H05 · 用量与充值 | DSH 卡片上有 DeepSeek 官方的「查看用量」「去充值」链接（只接受 https）。余额不足要去充值，重新登录解决不了。 |

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
- 原生侧：Codex 用 `account/read`、`getAuthStatus`、`account/rateLimits/read`；DSH 用 `account/getState`、`account/getProfile`，资料读取失败时再用 `account/getBalance`。
- 输出前遮盖邮箱、用户码和账号 ID。

**DSH 登录。** 需要一个没有凭据、数据目录可写、并且能访问 `platform.deepseek.com` 的 DSH Host。

- 发起：`POST /api/private/accounts/dsh/login` 返回 `kind: paste-back`、DeepSeek 登录页地址和 `callbackPrefix`（Host 自己的回环地址 `/oauth/callback`）。
- 登录：在 Host 回环地址打不开的浏览器里完成登录（比如手机），复制跳转后的完整地址。
- 完成：在页面粘贴，或调用 `POST /api/private/accounts/dsh/login/complete`，body 为 `{ callbackUrl }`。
- 读回：原生 `account/getState` 应为 `credential-stored`，`attempt.phase` 为 `succeeded`。

**登录码。** 只出现在发起登录的那一次响应中。验证时可以在服务端日志里搜索登录码的格式，结果应为零。

**收尾。** 隔离实验结束后，调用 `account/logout`，删除临时配置目录和容器。

## Gotchas

- **Codex 本地有凭据不等于可用。** 读账号即使要求刷新，刷新失败也不会出现在结果里，所以要靠读额度判断。读额度返回 401 时，中书会先让原生刷新一次再读；仍是 401 才判为失效，以免把“访问令牌刚过期、刷新令牌还有效”误报为失效。
- **无法续期的 Codex 凭据只报一次错**，之后就像没有账号。所有读账号的地方都要记录这次报错。一个刚启动的进程靠 `getAuthStatus` 区分“从未登录”和“凭据还在但不能用”。失效状态一直保持到核实成功；凭据被删掉后，仍显示“登录已失效”。
- **DSH 的核实资料可能失败而推理正常。** 原因见上一条。平台拒绝凭据时，原生会清除它，下次核实即为失效。
- **DSH 的资料与余额走平台的两条不同路由。** 资料是 `GET /auth-api/v0/users/current`，余额是 `GET /api/v0/users/get_user_summary`，都带同一份凭据。2026-11-07 在数据中心地址的服务器上，DeepSeek 的 CloudFront 边缘拒绝资料路由（403 “Request blocked”，与请求头无关），余额路由和登录用的 `POST /auth-api/v0/dsh/*` 照常到达平台。所以资料读取失败时，中书再读余额：余额就绪即为可用（不显示账号名），两者都失败才是暂时无法核实。排查时在 DSH 容器内分别请求这两条路由，看响应来自 CloudFront 还是源站。
- **DSH 访问 DeepSeek 平台可能被网络拦截。** 2026-11-07 在公司网络的本机上，容器访问 `platform.deepseek.com` 时证书链来自公司 Web 代理（`SELF_SIGNED_CERT_IN_CHAIN`），而 `api.deepseek.com` 不受影响。结果是：推理正常，但核实资料和余额一直失败，显示“暂时无法核实”；发起登录也立即失败（原生 `attempt.errorCode: no-response`）。排查时在 DSH 容器内分别请求这两个地址，比较结果。
- **新发起的 Codex 登录会顶掉旧的**：旧的会收到 `account/login/completed {success:false}`，取消旧的返回 notFound。
- **每次应用启动后，第一次核实如果是未登录或失效，会推送一次。**

## Implementation and regression

- 接入：[Codex](../../src/harness/codex/index.ts)（读账号、额度、设备码、通知）与 [DSH](../../src/harness/dsh/index.ts)（账号状态、资料核实、链接、粘贴登录）；401 与“无法刷新”在 [RPC](../../src/harness/codex/rpc.ts) 中识别。
- 核实、提醒与登录状态：[harness-accounts.ts](../../src/server/harness-accounts.ts)；视图结构：[shared/accounts.ts](../../src/shared/accounts.ts)。
- 界面：[功能层](../../src/web/harness-accounts.tsx)、[展示组件](../../src/web/patterns/harness-accounts.tsx)、[原型](../../design/stories/HarnessAccounts.stories.tsx)。
- 回归：[核实、推送、登录与接口](../../test/harness-accounts.test.ts)；Codex 与 DSH 的账号映射在 [codex.test.ts](../../test/codex.test.ts) 与 [dsh.test.ts](../../test/dsh.test.ts)。
