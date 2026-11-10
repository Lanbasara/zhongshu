# 司门：Agent 与 Chrome DevTools 之间的中间层

当前能力：Agent 在 shell 里用 `chrome-devtools` 操作浏览器，写法和官方 Chrome DevTools 命令行一样。实例只有一个浏览器；司门在中间分窗口、排队、收回，并且只在用的时候开浏览器。官方命令行原样执行，输出原样返回。决定见 [ADR 0023](../adr/0023-simen-browser-service.md)。

## Sub-features

| 场景 | 可证伪的结果 |
| --- | --- |
| B01 · 照官方写法用 | `chrome-devtools new_page <网址>`、`take_snapshot <页面>`、`click <页面> <uid>`、`take_screenshot <页面>`、`emulate`、`evaluate_script`、`list_console_messages` 等，输出和官方命令行一致。`--help`（包括 `chrome-devtools <命令> --help`）由官方命令行回答，不需要窗口，也不在这段对话的临时目录里留下东西 |
| B02 · 一段对话一个窗口 | `new_page` 给这段对话（`DSH_SESSION_ID`）分配窗口，实例最多 2 个。同一段对话再 `new_page` 时，以退出码 2 拒绝，并说出它自己的页面编号。用别的对话的页面编号也会以退出码 2 拒绝；没人拥有的页面（例如网页弹出的窗口）只有已有窗口的对话能用 |
| B03 · 排队 | 两个窗口都在用时，`new_page` 在 stderr 显示"正在排队（前面还有 N 个）"，先来先得；轮到时照常执行。等 5 分钟还没轮到，以退出码 4 结束并说明原因 |
| B04 · 收回 | `close_page` 自己的页面后，窗口立刻释放。窗口 5 分钟没用，司门会关掉它的页面，并删掉这段对话的临时目录。之后再用这个页面，会被拒绝并提示"闲置 5 分钟，已经收回" |
| B05 · 用时才开 | 没有窗口时，浏览器和官方后台进程都不在运行。除 `new_page` 外，其他页面命令会被拒绝，并提示先开窗口。最后一个窗口释放后，两者都退出，浏览器容器的内存回落 |
| B06 · 登录保留 | 像人用自己的浏览器一样：浏览器始终用实例的同一个数据目录，司门不清理它。带有效期的 cookie 和会话 cookie 在浏览器停了再开之后都还在 |
| B07 · 文件 | 相对路径（`--filePath`、上传文件等）按 Agent 当前目录换成绝对路径。没指定位置的截图存进这段对话的临时目录，路径 Agent 能直接读，窗口收回时删除。`file://` 能打开工作区里的 HTML |
| B08 · 不许另开 | `start`、`stop`、`status` 和 `--sessionId` 都以退出码 2 拒绝。官方后台进程只连实例的浏览器，不会自己再开一个 |
| B09 · 体检 | `chrome-devtools doctor` 显示司门和官方版本、浏览器是否在运行、窗口归属与闲置时间、排队长度、内存。读不到令牌、连不上或协议不一致时，以退出码 3 结束 |
| B10 · Agent 知道它 | 实例配置 `agentTools.browser` 时，中书 MCP 服务在 `initialize` 的说明里写"用浏览器时运行 `chrome-devtools`" |

## How to get to it (user POV)

用户不直接操作。在接了司门的实例里，对 DSH 对话里的 Agent 说"打开某个网页看看""检查这个 HTML 在手机上会不会溢出并截图"，Agent 会运行 `chrome-devtools`。

## Driving it with Harness

遵循[共同入口](README.md#独立执行验收)。需要 [native 现场](README.md#native真实接入分支)的 DSH，以及操作者按 [README](../../README.md#simen) 配好的浏览器服务（司门宿主 + Chromium + 固定版本的 chrome-devtools-mcp）和放进 DSH 的 `chrome-devtools`。

1. **B01/B07/B10。** 在一段 DSH 对话里，让 Agent 检查工作区里的一个 HTML 在电脑和手机宽度下的样子并截图。期望看到：
   - Agent 运行了 `chrome-devtools new_page file://…`、`emulate`、`take_screenshot`；
   - 截图在 `/simen/tmp/<对话>/…` 下，Agent 能读到。
2. **B02/B03。** 同时开三段对话，各自 `new_page`。期望看到：
   - 第三段在 stderr 看到排队提示；
   - 前两段之一 `close_page` 后，第三段拿到窗口；
   - 拿别的对话的页面编号去操作会被拒绝；
   - 要看“等 5 分钟 → 退出码 4”，占着窗口的两段对话要每 30 秒用一次自己的页面（例如 `evaluate_script --pageId N '() => 1'`），否则 5 分钟闲置收回会和 5 分钟排队上限同时到点。
3. **B04/B05。** 留一个窗口不用，等 5 分钟以上，再用它的页面编号，期望看到"已经收回"。`chrome-devtools doctor` 显示窗口 0、浏览器没开，浏览器容器的内存回落（没有宿主权限时，用 doctor 的「内存」行作证据；容器内存与官方后台进程是否退出需要宿主权限）。
4. **B06。** 在测试站点写入一个带有效期的 cookie 和一个会话 cookie，等浏览器因闲置停掉，再开窗口读 cookie，两者都应还在。
5. **B08/B09。** 运行 `chrome-devtools start` 和带 `--sessionId` 的命令，期望退出码 2。用读不到的令牌文件运行 `doctor`，期望退出码 3。

## Gotchas

- **写法是官方的。** 必填参数按位置写，选填参数写成 `--名字 值`，页面编号在大多数命令里是第一个位置参数，`evaluate_script` 用 `--pageId`。拿不准时看 `chrome-devtools <命令> --help`。
- **第一次开窗口要几秒**，因为要先启动浏览器和官方后台进程。
- **CPU 是瓶颈。** 两个重页面同时加载，并不比一个接一个快。
- **遥控端口在实例回环上。** Agent 绕过司门直接连浏览器是做得到的；司门防的是无意中越开越多，不防恶意（ADR 0023）。
- **网站有人机验证时**，司门不替用户通过。

## Implementation and regression

- 规则：[windows.ts](../../src/simen/windows.ts)（窗口、排队、闲置，纯函数）。参数：[args.ts](../../src/simen/args.ts)（按官方命令表找页面编号和路径）。
- 宿主：[host.ts](../../src/simen/host.ts)（HTTP、令牌、协议、分配与收回，浏览器和官方命令行可注入）。实际的浏览器和官方命令行：[runtime.ts](../../src/simen/runtime.ts)。命令：[cli.ts](../../src/simen/cli.ts)。协议：[protocol.ts](../../src/simen/protocol.ts)。
- 中书：[agent-tools.ts](../../src/server/agent-tools.ts) 的 `BROWSER_INSTRUCTIONS`，[harness-config.ts](../../src/server/harness-config.ts) 的 `agentTools.browser`。
- 回归：`node --test test/simen-windows.test.ts test/simen-args.test.ts test/simen.test.ts`。覆盖规则、参数、宿主与命令的端到端（假浏览器和假官方命令行），以及说明开关。它们不代替真实浏览器的路径。
