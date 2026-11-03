# 界面与组件工作台：feature map

本页维护界面交互、设计基础的消费入口和开发资源的发布隔离。职责及扩展规则归 [architecture](../architecture.md#界面与设计系统)，已确认的本轮范围归 [spec](../spec/design-system-workbench.md)。业务行为仍按各能力地图验证；Storybook 不证明原生执行。

## Sub-features

| 场景 | 要证明的行为 |
| --- | --- |
| I01 | 主界面导航、阅读、输入与工作区文件协调，切换工作区不改变主题 |
| I02 | 输入增长、材料菜单、配置浮层、键盘及窄屏操作可用，减少动效有对应行为 |
| I03 | 新视觉下真实应用的创建、发送、停止、草稿与刷新路径保持正确 |
| I04 | Storybook 使用产品组件展示可操作状态，参考原型清楚隔离 |
| I05 | 产品构建和最终产物不含开发界面，隔离检查能识别反例 |

## How to get to it (user POV)

产品按[共同入口](README.md)启动并登录。侧栏“新对话”创建，标题栏“收起导航”调整阅读空间，“打开工作区文件”进入阅读器；窄屏使用“打开对话导航”。输入框为“给 Agent 的消息”；加号的可访问名称为“添加图片或文件引用”，菜单内选择“添加图片”或“引用工作区文件”。模型名称按钮为“当前对话配置”。普通 Enter 换行，Cmd/Ctrl+Enter 发送；中文输入法合成期间不发送。

开发入口：仓库根运行 `npm run storybook`，打开终端给出的本地地址（默认 6006）。侧栏按“设计基础”“产品模式”“设计参考”查找 stories；它没有产品账号、连接配置或真实会话。历史原型在“设计参考”中展示。

## Driving it with Harness

沿用共同入口的 Launch/Doctor/Evidence/Cleanup，记录版本与差异，使用自己的数据目录、浏览器上下文和空闲端口。I01–I03 使用真实产品构建加 fixture 可验证界面与应用边界；原生任务需另按 [E05](execution.md)、[U01](conversation-usability.md) 实际驱动，不能从 fixture 或 stories 外推。

**I01：布局与导航。** 创建 Fixture A 与 Fixture B 下各一个唯一命名对话。在两者间切换，比较 body、按钮、选中项的计算颜色，变化应表达选中与状态，不跟随工作区换肤。在 1280px 及 390px 视口分别操作导航、搜索、切换和关闭；在 320px 输入长中文及无空格长串。以 documentElement 的 scrollWidth 不超过 clientWidth、主要按钮处于视口内、输入仍可编辑为判据。桌面收起/展开导航后草稿仍在。窄屏打开导航，Tab 不离开抽屉，Escape 关闭后焦点返回触发按钮；分别在提示气泡可见/不可见时检验。打开抽屉里的“管理对话”子框，第一次 Escape 只关闭子框，第二次才关闭导航；忙碌时仍遵守原操作的关闭限制。为本次合成工作区放入一个普通 Markdown 文件（可信端只准备文件，不写产品 DB），从“打开工作区文件”选择阅读；在 1000px 展开为全屏再收回，关闭后回到原对话。工作区读取细节另见 [workspace-files](workspace-files.md)。

**I02：输入与状态。** 输入多段文字，确认增长到上限后在内部滚动，不挤出发送按钮。打开材料菜单，用键盘进入项目，再 Escape 关闭；打开配置浮层，核对模型/权限来自当前对话且长名称仍可查阅，Escape 回到触发按钮。文件引用按 [U07](conversation-usability.md)；图片选择与失败重试按 [U04/U08](conversation-usability.md)。查看实际附件预览，移除后不进入提交。普通 Enter 只换行，Cmd/Ctrl+Enter 只发送一次。中文合成、真实剪贴板、拖放与手机软键盘分别记录覆盖，工具不能驱动的项目不可写 PASS。通过浏览器模拟或系统减少动态效果设置切换 prefers-reduced-motion，查看抽屉/菜单/附件区与加载图标；减少动效下无持续旋转与位移，不仅检查媒体查询字符串。结束恢复测试视口与系统设置。

**I03：真实应用接线。** 两个独立 fixture 对话各跑 [C01](conversations.md)。在其中一段发送唯一消息（保存操作编号），执行中输入下一条草稿，再“停止当前轮”；按 [E03](execution.md) 独立 inspect 核对 stopCalls 与原操作。完整刷新，核对同一对话/历史/草稿，再发送并用 fixture complete 结束；inspect 中提交计数只增加一次。切换另一对话再返回，输入不串。另按 [E04](execution.md) 真实发送拒绝/丢回执路径检查错误与输入恢复；这些故障方法不应因 UI 改造改变。与真实 Harness 相关的输入、工具、恢复走既有 U01/E05，记录模型时间预算和文件独立读回。

**I04：组件工作台。** `npm run build:storybook` 后产物只在 `.artifacts/storybook`。启动 Storybook，操作基础按钮/菜单/浮层；输入模式分别查看默认、执行中、待核实、上传失败、长模型名称，测试可编辑与禁用的差异；完整工作台 story 折叠导航、打开阅读器、输入文字。再次以 390px 查看。设计参考 iframe 明示历史模拟；它不调用产品服务，组件故事的演示操作不提交真实任务。检查浏览器错误；截图不能代替组件动作。开发服务端口冲突时用 `npm run storybook -- --port <空闲端口>`，不要停止他人的进程。

**I05：发布隔离与反例。** 运行四项仓库检查，再 `npm run build:storybook && npm run check:release`。以 `node --test test/design-boundaries.test.ts` 检查静态/动态/type import、公共资源改名/混入与构建后文件修改的反例；还要在一次性源码副本进行以下真实构建检查，不能污染正在验证的应用：

1. 给产品入口追加一个指向 `design/` 的 import（即使未使用），构建应以 Build boundary 拒绝；恢复后能构建。
2. 将任意原型 HTML 复制到 `src/web/public/prototype.html`，构建应拒绝；恢复后能构建。
3. 正常构建完成后将示例文件放进 `dist/public/` 或改写 index.html，`npm run check:release` 应拒绝；重建后通过。
4. 构建真实 Docker 镜像，Dockerfile 的最终阶段执行 `--image` 检查。独立检查运行镜像里没有 design、.storybook、storybook-static、Storybook npm 包；不能以 .dockerignore 或源码 grep 代替镜像证据。

检查防止误引入和打包漂移，不抵抗恶意修改检查本身。新增公共资产时须同时审查文件和摘要；不要为了反例通过而修改清单或关闭插件。测试结束删除自己的副本和测试镜像，保留构建输出/退出码与失败判据。浏览器或 Docker 前提缺失分别记录 BLOCKED。

## Gotchas

- 原型的演示文字/回复不是产品默认数据。固定视觉参考与当前组件故事是不同证据。
- I03 中停止轮次不等于所有后台工具退出；沿用执行地图的真实语义。
- 统一 token 不是禁止所有几何尺寸；语义颜色/字体/时序从基础层消费，具体布局仍由模式负责。
- 本地窄窗口不证明 Android 真机、输入法或后台唤醒；仅有 CSS 规则不证明减少动效的实际执行。
- 构建后不要继续让旧应用提供新旧混合资产，重新启动 fixture；不要覆盖用户试用的实例。

## Implementation and regression

[设计基础](../../src/web/ui/)、[展示模式](../../src/web/patterns/)、[真实输入](../../src/web/composer.tsx)、[工作台](../../src/web/workbench.tsx)、[stories](../../design/stories/)、[隔离检查](../../scripts/design-boundaries.ts)、[产物校验](../../scripts/check-release.mjs) 是定位入口。生成器 `node scripts/design-tokens.mjs --check` 检查 CSS 与作者源一致；`npm test` 包含边界反例，CI 同时构建产品、Storybook 和镜像。
