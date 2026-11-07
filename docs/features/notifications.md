# 通知与安装

决定见 [ADR 0018](../adr/0018-push-notifications.md)。

## Sub-features

| 场景 | 可证伪的结果 |
| --- | --- |
| N01 · 开启与测试 | 在「设置 → 通知」为这台设备开启通知，设备列表出现「这台设备」。发测试通知后，这台设备的 service worker 显示「中书测试通知」。 |
| N02 · 完成、失败与等待 | 没有页面在看某段对话时，它的运行结束（完成、失败或意外中断）或开始等待回答与审批，每台已开启的设备都收到一条通知。标题是对话标题，正文说明哪个 Harness 发生了什么。 |
| N03 · 不打扰 | 有可见页面正在看这段对话时，不推送；用户主动停止的运行不推送；同一个结果只推送一次。同一对话的新通知替换旧通知。 |
| N04 · 直达 | 点通知：已打开的页面切到对应对话（账号提醒打开设置）；没有打开的页面时，新开一个窗口直达。 |
| N05 · 管理与失效 | 在设备列表移除任意设备后，它不再收到通知；移除这台设备时也取消浏览器订阅。推送服务报告订阅已失效（404/410）时，服务端删除该设备。 |
| N06 · 安装 | Chrome 判定中书可安装（无 installability 错误，识别 192/512 与 maskable 图标）。安装后以独立窗口打开；支持时，图标角标显示未读数。 |
| N07 · 内容与边界 | 解密后的推送只含事件类型、对话标题、对话编号、未读数和固定文案。推送地址不出现在接口响应和日志中。未登录、缺少 CSRF 或地址不属于浏览器推送服务的订阅请求被拒。 |

账号提醒（「Harness 账号需要处理」）的事件类型已就绪；检测与触发由 Harness 账号能力提供，在那里验证。

## How to get to it (user POV)

登录后从侧栏底部「设置」进入「通知」标签（手机上先点左上角「打开对话导航」）。「这台设备」卡片显示当前状态，可开启、发测试通知或关闭。下方列出所有已开启的设备，可逐个移除。「安装」卡片在浏览器提供安装时显示「安装中书」；已安装时说明正在独立窗口中运行；iPhone 提示从 Safari 添加到主屏幕。

iPhone 和 iPad 只给主屏幕应用发通知：先从 Safari 添加到主屏幕，再从主屏幕打开中书开启。

## Driving it with Harness

**前提。**

- 一个能连上浏览器推送服务的真实浏览器：Chrome 走 Google，Firefox 走 Mozilla，Safari 走 Apple。
- 应用所在机器也要能访问同一推送服务。
- `http://127.0.0.1` 属于安全上下文，本地实例可以直接测。

**自动化浏览器。** 可以用独立配置目录的 Chrome（包括 headless）。

- 用 CDP `Browser.grantPermissions({ origin, permissions: ['notifications'] })` 代替点击权限弹窗。这个授权只在本次浏览器会话有效，每次启动都要重新授予。
- 用同源页面脚本读取 `navigator.serviceWorker.ready.then(r => r.getNotifications())` 的 `title`、`body`、`tag`、`data.url`，作为“设备显示了什么”的读回。
- 服务端是否送达推送服务，看 `GET /api/private/push` 中设备的 `deliveredAt` 与 `failure`。返回 201 只说明推送服务收下了，不能代替设备读回。

**N02/N03 驱动。**

1. 浏览器停在「设置 → 通知」（设置页不算在看对话）。
2. 另起一个已登录的 API 客户端，新建合成对话，发一条“只回复 OK”的消息，等对话回到 idle，读回通知。
3. 等待：用 DSH 只读权限请求写文件，出现审批即应收到「在等你回答或批准」；拒绝后运行结束，同一 tag 的通知被替换为「已完成」。
4. 不打扰：让页面打开该对话（`#<对话ID>`，页面可见）再发一轮，`deliveredAt` 不变。
5. 主动停止：在运行中发 `stop`，终态为 interrupted，`deliveredAt` 不变。
6. 失败分支需要能让原生运行失败的条件；没有时记为未覆盖，回归测试覆盖规则本身。

**N04 驱动。**

- 真机上直接点通知。
- 自动化时，经 CDP 附着到 `service_worker` 目标，用 `getNotifications()` 取出对应通知，派发 `new NotificationEvent('notificationclick', { notification })`。已打开的页面应切到 `#<对话ID>`，标题变为对话标题。
- 合成事件没有用户激活，`focus()` 与 `openWindow()` 会被拒绝，所以“没有打开的页面时新开窗口”只能在真机上验证。

**N06 驱动。** 对已登录页面执行 CDP `Page.getInstallabilityErrors` 与 `Page.getAppManifest`。真机上从浏览器菜单安装，确认独立窗口与图标。

## Gotchas

- **推送地址的主机会变。** Chrome 159 的地址是 `https://jmt17.google.com/fcm/send/…`，旧版是 `fcm.googleapis.com`。服务端按厂商根域名放行。新浏览器被拒时（`push_service_not_allowed`），先核对地址主机，不要放开为任意 HTTPS。
- **权限与订阅。** 浏览器在没有通知权限时收到推送，可能直接取消订阅，之后设备显示「未开启」或「需要重新开启」。自动化测试先授权再开启。
- **服务端代理。** 应用用 Node 内置 `fetch` 发推送，默认不读取 `HTTP_PROXY`。只能经代理出网的机器需要操作者另行配置（例如 Node 的 `NODE_USE_ENV_PROXY=1`），否则设备显示「连不上推送服务」。
- **国产安卓的后台限制。** 2026-11-07 在 ColorOS 手机上验收：Chrome 前台时测试通知能收到。从最近任务上滑划掉后，任务完成时服务端已在同一秒送达推送服务，但手机没有显示，直到重新打开 Chrome 才补到。原因是系统冻结或强制停止了 Chrome；靠代理连 Google 时，代理 App 也可能被一起关掉。这类手机需要给 Chrome、代理 App 和 Google Play 服务开启后台运行和自启动，并在最近任务里锁定，不要上滑划掉。判断时先看设备的 `deliveredAt`：时间与运行结束同秒，说明服务端这一段已经正常。
- **送达时效。** 推送服务最多保留 12 小时，同一对话以 Topic 只保留最新一条。手机长时间连不上推送服务时，旧提醒会作废，未读状态仍在中书里。
- **service worker 的职责。** 它没有 fetch 处理器，也不缓存，页面与接口请求照常到服务器。每次加载都会注册 `/sw.js`，不打开设置页也会更新。
- **密钥更换。** 推送密钥存在实例数据库，首次读取设置时生成。更换后，旧订阅显示「需要重新开启」。

## Implementation and regression

- 加密与签名：[web-push.ts](../../src/server/web-push.ts)，RFC 8291/8292，只用 `node:crypto`。
- 设备、发送与私有接口：[push.ts](../../src/server/push.ts)。
- 状态到事件：[push-triggers.ts](../../src/server/push-triggers.ts)。
- 消息文案：[shared/push.ts](../../src/shared/push.ts)。
- service worker：[sw.js](../../src/web/public/sw.js)。
- 浏览器端：[push-client.ts](../../src/web/push-client.ts)。
- 设置页：[功能层](../../src/web/notification-settings.tsx) 与 [展示组件](../../src/web/patterns/notifications.tsx)。
- 原型：[Storybook](../../design/stories/Notifications.stories.tsx)。
- 回归：[RFC 向量与签名](../../test/web-push.test.ts)、[订阅、送达、触发与接口](../../test/push.test.ts)。
