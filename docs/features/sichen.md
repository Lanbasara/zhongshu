# 司辰：时间模块与命令行

当前能力：Agent 和人用 `sichen` 命令管理定时任务和日历条目。时间用日期和钟点写，命令先检查再交给中书，DSH 任务由原生调度，Codex 任务由中书定时交给原生对话执行（[ADR 0026](../adr/0026-shared-agent-capabilities.md)）；建好后会读回接下来几次的运行时间。网页「日程」和命令行共用同一个时间模块，所以都能设结束日期。决定见 [ADR 0022](../adr/0022-sichen-time-module.md)，自动任务本身见 [automations](automations.md)。

## Sub-features

| 场景 | 可证伪的结果 |
| --- | --- |
| S01 · 说人话建任务 | `sichen schedule add <名称> --prompt … <时间> --to …` 建出 DSH 原生任务。输出编号、规则描述（如"每个工作日 14:45 · 到 2027-01-31"）、接下来三次运行时间（带"明天 / N 天后"）和结果放哪。时间写法有：`--at`、`--every 每天/工作日/周一,周三/mon-fri`、`--monthly N [--months …]`、`--cron`，可加 `--from`、`--until`、`--tz`，默认取本机时区 |
| S02 · 先检查再建 | 日期不存在、钟点不对、一次性时间已过、结束早于开始、所选月份没有那一天、规则到结束前一次都不跑，都会在命令行里用中文说明，以退出码 2 结束，不发请求，也不建任务。服务端用同一个模块再查一遍，不合格时返回 `invalid_time` 和原因列表 |
| S03 · 结束日期 | 有结束日期（或开始日期、按月）的规则，以带 `UNTIL` 的 RRULE 交给 DSH，`UNTIL` 是结束那天最后一秒换算成的 UTC 时间。DSH 到期后自己结束任务。卡片和 `sichen` 的描述里写"到 YYYY-MM-DD"，日历只排到那天。网页新建和修改每天、每周的任务时也能设、能去掉结束日期 |
| S04 · 回到本对话 | `--to 本对话` 投递到运行命令的对应 Power 的原对话，靠 shell 的 `DSH_SESSION_ID` 或 `CODEX_THREAD_ID` 认出。缺少会话身份时，命令行直接拒绝。`--to 新对话` 和 `--to 首次新开` 在命令所在目录对应的已登记工作区里新开对话，目录不在任何工作区时拒绝 |
| S05 · 管理任务 | `list [--state 开启/暂停/结束/全部]`、`show`、`edit`（可改名称、指令、时间，或用 `--until`/`--no-until` 只改结束日期，保留原来的日子和钟点）、`pause`、`resume`、`delete`、`run`。任务已结束时，`edit`、`pause`、`resume` 都拒绝并说明（原生会接受并让一次性任务重新开启，所以中书先查）；页面/接口对已结束任务改动的契约是 HTTP 200、正文 `{"outcome":"ended"}` 且不写入，命令行以非 0 退出。命令行不带版本号，只有原生自己报冲突时才说“别处改过” |
| S06 · 日历条目 | `sichen timeline add <操作/大事/决定/研究> <标题> --at "日期 钟点"\|--date 日期 [--link] [--detail] [--id]` 往当前工作区的 `.zhongshu/timeline.jsonl` 追加一行。先用日历的同一个解析器检查，越出工作区的链接会被拒绝。`done` 和 `cancel` 用同一编号追加完成或取消；`list` 列出从今天起的条目 |
| S07 · Agent 知道它与任务编写指导 | 已配置的 DSH 与 Codex 共用中书 MCP `initialize.instructions`：定时任务和日历条目用 `sichen`，先看 `--help`，不要手写 RRULE 或时间轴 JSON。创建或修改任务时，指引要求交代未来目的和必要背景，按需提供能力与资料入口、所查时点，并标明时效事实与暂定判断自身的日期；区分用户要求与 Agent 暂定判断，后者留待按届时证据复核，而非未来必须维持的结果；保留用户固定规则的核验和授权边界，新对话不能依赖原聊天历史 |
| S08 · 版本与体检 | 命令每次请求都带协议版本，中书版本不同时返回 `protocol_mismatch`，命令行说明要更新哪一边。`sichen --version` 显示版本和构建；`sichen doctor` 检查令牌可读、能连上中书、协议一致、是否接通 DSH 定时任务、是否在 DSH 对话里，有问题时以退出码 3 结束 |

## How to get to it (user POV)

Agent 在 Codex 或 DSH 的 shell 里运行 `sichen …`。人也可以在 DSH 容器里，或任何能访问中书回环端点并有令牌的地方运行。网页上，「日程」里新建、修改每天或每周的任务时，表单下方有"结束日期"。

## Driving it with Harness

遵循[共同入口](README.md#独立执行验收)。需要 [native 现场](README.md#native真实接入分支)的 DSH 0.2.2 及以上，以及操作者按 [README](../../README.md#sichen) 配好的 `agentTools`，再把 `sichen` 和令牌交给两边运行环境。在 Codex 重跑 S01、S03、S04、S06 和 S07，核对日程归属、原线程运行、任务卡结论以及 DSH 原有任务编号和历史。

1. **S07/S01/S04。** 在一个没有任何工作区约定的对话里，对 Agent 说"每个工作日 14:45 检查……，到某天为止，结果回到这段对话"。期望看到：
   - Agent 运行了 `sichen`，而不是原生 `schedule_create`；
   - 原生任务的 `rrule` 带 `UNTIL`，目标是这段对话的会话；
   - 日程卡片写着"到 YYYY-MM-DD"。
2. **S03。** 用 `sichen` 建一个两三分钟后开始、当天结束的每日任务，等它运行，再读原生任务：状态应为已结束，此后不再投递。
3. **S02/S05。** 依次给一个不存在的日期、一个已过的时间、一个错误的星期写法，确认退出码是 2，并且任务列表没有变化。再用 `edit --until` 和 `--no-until` 改一个每周任务，读回的星期和钟点不变。
4. **S06。** `timeline add 操作 …` 后，读回 `GET /api/private/workbench/timeline`，再看日历上的位置和时区；`done` 之后这条显示完成。
5. **S08。** 把令牌文件换成读不到的路径，运行 `sichen doctor`，应以退出码 3 报出问题；再用错误的协议头直接请求接口，应返回 `protocol_mismatch`。
6. **S07 · 未来任务的内容。** 只在获授权的隔离 native 现场，分别以 DSH 和 Codex 的新对话执行；不要用正在试用的实例或既有任务。准备一份合成资料，让 Agent 先给出暂定判断，再请它为一个明确的未来时点创建复核任务，结果放在新对话，提供资料入口和所需能力。另做一组用户明确指定固定规则的核验任务，并限定只报告、不得修改资料。两组都用 `sichen schedule show <编号> --json` 独立读回已存指令，核对目的、必要背景、所需资料/能力入口、所查时点，以及时效事实与暂定判断自身的日期没有遗漏；暂定判断未变成必须维持的结果，固定规则未被擅自替换，授权未扩为执行其他动作。再请 Agent 修改本次测试任务的资料入口，读回确认这些边界仍在。不能只看 Agent 的“已建好”回复；简单提醒不要求添加无关的资料或能力字段。
   - 在隔离现场改变合成资料，使旧暂定判断不再成立，再从任务卡“立即运行”驱动新对话。检查新对话实际读取了指定资料、按届时证据复核，未因缺原对话而失去背景；固定规则组仍按用户规则报告核验结果，没有越权修改资料。分别记录“指令送达”“任务内容”“实际执行”，任一层未跑不能算通过。
   - 保存本次任务编号、读回内容、运行对话及合成资料前后证据；删除且只删除本次测试任务，并按共同入口回收本次现场。没有隔离 Host 或共同 MCP 配置时，将对应 native 分支记为 `BLOCKED`，不得以 HTTP 返回或文本匹配代替。

## Gotchas

- **指导不是任务迁移或执行授权。** `initialize` 只下发共同说明，不改写或审查任务 prompt，也不自动更新已存任务。客户端取得说明、Host 把它放入模型上下文、模型按它编写并执行任务是不同证明层；仅协议回归不能证明后两层。
- **令牌文件。** 命令默认读 `/links/sichen-token`，可用 `SICHEN_TOKEN_FILE` 改；回环地址默认 `http://127.0.0.1:3100`，可用 `SICHEN_URL` 改。令牌和通知工具用的是同一个，只授权通知、回填结论和司辰的操作。
- **时区。** 命令用本机时区；VPS 的 DSH 容器设成了上海时间。`--tz` 可以换。
- **cron 写法不能设开始或结束日期**；需要结束日期时，改用 `--every` 或 `--monthly`。
- **网页只能编辑每天、每周、一次性和固定间隔的时间。** 按月和 cron 的任务只显示，时间用 `sichen schedule edit` 改。
- **开始日期已经到了就不再显示。** 有结束日期的规则在 RRULE 里带着开始那天，但描述里只在开始日期还没到时才写"从 … 起"。

## Implementation and regression

- 时间模块：[src/sichen/time.ts](../../src/sichen/time.ts)（零依赖，服务端、网页和命令行共用）。协议：[protocol.ts](../../src/sichen/protocol.ts)。命令行：[cli.ts](../../src/sichen/cli.ts)，构建为 `dist/sichen/bin/sichen`。
- 服务端：[sichen-api.ts](../../src/server/sichen-api.ts) 挂在 [agent-tools.ts](../../src/server/agent-tools.ts) 的回环服务上。任务操作由 [automations.ts](../../src/server/automations.ts) 的 `operations` 提供，时间轴追加用 [workspace-documents.ts](../../src/server/workspace-documents.ts) 的 `appendWorkspaceTimeline`。
- 共同任务编写指导：[agent-tools.ts](../../src/server/agent-tools.ts) 的 `SICHEN_INSTRUCTIONS`；同一个 `initialize` 分支向两种客户端返回说明，未配置司辰路由时不下发。
- 回归：`node --test test/sichen-time.test.ts test/sichen.test.ts`。覆盖时间写法的检查与换算、`UNTIL`、读回还原、接下来几次运行、令牌与协议、本对话、修改结束日期、时间轴写入，以及命令行到服务的端到端调用。MCP 回归检查两种客户端标识和支持的协议版本取得同一编写指导、关键条款存在、未配置时不下发，初始化不创建或修改任务；它不替代 DSH/Codex 的上下文注入与模型行为实跑。
