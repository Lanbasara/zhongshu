# 实例级插件管理

## Sub-features

| 场景 | 可证伪的结果 |
| --- | --- |
| P01 · 发现和安装 | Codex 与 DSH 有各自的目录。搜索知行，从当前页确认来源和目标再安装，刷新后当前端的原生清单与页面均显示安装版本及启用状态。 |
| P02 · 启停与卸载 | 停用后包仍在，重新启用后恢复，卸载后原生清单中没有安装项；刷新保持一致。 |
| P03 · 范围和授权 | 一端安装或变更不影响另一端、合成工作区文件或独立原生环境。未登录、跨来源、无 CSRF、工作区参数和账号来源的直接变更请求被拒。 |
| P05 · 用户管理市场来源 | 从零分别添加 Codex GitHub 市场和 DSH 原始索引 URL，浏览、筛选、查看详情并安装。卸载后可以移除自加来源。 |
| P04 · 失联和待生效 | 原生接受但需要重启时显示对应状态；请求结果未知时可读回同一操作，未取得证据前不显示成功，也不自动重新提交。 |

## How to get to it (user POV)

登录工作台，从侧栏打开「插件管理」主页面。选 Codex 或 DSH，再切换「发现」和「已安装」。使用「添加来源」录入对应原生市场，使用「管理来源」查看和移除自己添加的市场。在「发现」选择市场或搜索名称，选条目打开详情。安装、停用、启用、卸载都有确认步骤，范围为「当前实例」，不选工作区。操作后等待状态落定，然后刷新页面、重新打开同一端核对。端点失联或未配置时，页面会区别显示。

## Driving it with Harness

使用[共同入口的 Native 现场](README.md#native真实接入分支)，为被测 Harness 准备独占连接。P01–P04 使用预设的知行市场，P05 从该端的空市场配置开始。各端可分别执行，再用双端实例核对隔离。使用合成工作区并保存变更前的工作区摘要和原生清单。P03 同账号分支需要操作者提供两套允许实验的原生环境。

### 准备原生连接

在[基础 Harness 配置](../../README.md#harness-connections)上按需启用插件管理。

**Codex** 使用 `0.166.0-alpha.5.1`。在目标 App Server 所在实例运行管理进程。两者使用同一个实例专用的 `HOME` 和 `CODEX_HOME`。将下例保存为操作者所有的 `0600` JSON，目录使用真实路径。管理 socket 的父目录、`home` 和 `codexHome` 归管理进程用户所有，权限设为 `0700`。保留管理 socket 目录中的 `market-sources.json`，以便重启后恢复用户添加的市场。

```json
{
  "socket": "/run/codex-plugin-manager/manage.sock",
  "nativeSocket": "/run/private-codex/app.sock",
  "executable": "/opt/codex/bin/codex",
  "gitExecutable": "/usr/bin/git",
  "home": "/srv/instance-codex/home",
  "codexHome": "/srv/instance-codex/state",
  "version": "0.166.0-alpha.5.1",
  "markets": [
    { "name": "approved-market", "url": "https://github.com/example/market.git", "revision": "0123456789012345678901234567890123456789" }
  ]
}
```

```sh
ZHONGSHU_CODEX_PLUGIN_CONFIG=/run/operator/codex-plugin-manager.json node dist/server/codex-plugin-host.js
```

在应用的 `codex` 配置添加 `pluginManagerSocketPath`，指向示例中的 `socket`。应用的 `socketPath` 和管理进程的 `nativeSocket` 必须能识别同一个 App Server socket。通过私有连接向应用提供管理 socket，执行环境不挂载管理 socket 或管理配置。预设市场须在相同原生实例中以 `codex plugin marketplace add --ref <commit> <https-git-url>` 登记，用 `codex plugin marketplace list --json` 核对市场名。P05 使用 `"markets": []`。

**DSH** 使用 Web Host `0.2.1-rc.5`。在实例专用的 Web profile 启用 `@deepseek-ai/dsh-experimental-plugin-market-bundle`，并为原生 Host 提供包管理器（如 pnpm）。可通过 DSH 原生市场 UI 或 `pluginMarket/setIndexes` 设置预设索引，后者接受 `{ "urls": ["https://example.com/immutable-index.json"] }`。在应用的 `dsh` 配置中填写对应的 `pluginSources`，例如 `[{ "label": "测试市场", "url": "https://example.com/immutable-index.json" }]`。P05 使用 `"pluginSources": []` 且原生索引为空。

### 执行与读回

- P01：先装其中一端，另一端刷新仍不显示安装。Codex 通过同一 `CODEX_HOME` 的原生 `codex plugin list --marketplace <name> --available --json` 核对 `pluginId`、版本和 `enabled`，并从同一 App Server 用 `skills/list` 查询合成工作区的插件技能。DSH 通过同一 launch 对应的 Web Host `pluginManager/listBundles` 核对包来源、版本、启用和加载条目；再查新会话的能力。原生读回示例见下方。DSH 有可用实验模型时，发送一条调用知行 Skill 的合成请求，核对原生会话事件实际加载的 Skill 内容。
- P02：分别做停用、重新启用、卸载，每次等待页面落定并刷新，再独立读回上面的包清单。停用后包仍在且为 disabled；卸载后当前端没有已安装项。操作其中一端时保留另一端已安装，比较其清单。
- P03：比较工作区摘要和独立原生环境的前后清单。从无登录上下文读私有插件入口应返回 401。从已登录的同源页面读取 `/api/session` 的 `csrfToken`，仅用于同源请求的 `x-csrf-token` 头。对 `/api/private/workbench/plugins/codex/operations` POST JSON `{ id: crypto.randomUUID(), pluginId: "gmail@openai-curated-remote", action: "install" }` 应返回 403 `plugin_action_forbidden`。省略 CSRF 或使用错误 Origin 返回 403，加入 `workspaceId` 返回 400。保留状态和错误码，不记录认证信息。
- P05：从允许管理来源的空目录开始。在 Codex 添加 `Lanbasara/jianwei-marketplace`，从 GitHub 市场读出见微；在 DSH 添加 `https://raw.githubusercontent.com/Lanbasara/jianwei-marketplace/main/dsh/index.json`，确认来源下拉项和详情版本历史。在 DSH 选择一个兼容版本安装，切换到另一兼容版本，每次在原生包清单读回准确版本。DSH 来源通过 `pluginMarket/listIndexes` 核对 URL，读包清单时将下方示例中的 `zhixing` 改为 `jianwei`；在 Codex 安装当前市场固定的发行，用上面的 CLI 清单命令指定 `--marketplace jianwei`。刷新页面核对来源与状态。保留一个已安装项尝试移除其市场，预期保留来源并提示卸载；卸载后移除，另一 Harness 的来源保持原样。给 DSH 输入私有地址，预期拒绝。
- P04：在独占现场用[浏览器故障控制](README.md#drive控制与读回)在确认前用 `window.zhVerify.dropNext("/api/private/workbench/plugins/dsh/operations")` 丢弃一次操作响应，Codex 场景替换为 `codex`。保存 `window.zhVerify.status().journal` 中的请求 ID，再刷新，从同源 `GET /api/private/workbench/plugins/<harness>` 的 `operation` 读回同一 ID 和状态，并核对原生清单。需要重启的分支必须由原生返回该结果，记录回执，再按操作者入口重启本轮 Host，点击「核对原生结果」。未观察到原生重启结果时把该分支记为未覆盖。

原生读回可在仓库根目录用 `node --input-type=module` 执行。以本轮绝对路径替换 `<…>`，不要把 launch 文件正文复制到脚本或报告。按需要执行其中一个 Harness 的部分。

```js
import { CodexRpc } from './src/harness/codex/rpc.ts';
import { Connection } from './src/harness/dsh/connection.ts';

const cwd = '<合成工作区>';
const codex = new CodexRpc('<App Server Unix socket>', {
  notification() {}, unsupportedRequest() {}, disconnected() {},
});
try {
  const result = await codex.request('skills/list', { cwds: [cwd], forceReload: true });
  console.log(result.data.flatMap(item => item.skills)
    .filter(skill => skill.name.startsWith('zhixing:'))
    .map(({ name, enabled }) => ({ name, enabled })));
} finally { await codex.close(); }

const dsh = new Connection('<独立 Host launch 文件>');
try {
  const bundles = await dsh.call('pluginManager/listBundles');
  console.log(bundles.filter(bundle => bundle.name === 'zhixing')
    .map(({ name, version, enabled, source, rows }) => ({
      name, version, enabled, source, loaded: rows.filter(row => row.entryId).length,
    })));
  const { sessionId } = await dsh.call('session/create', { request: { cwd } });
  const { skills } = await dsh.call('skills/list', { request: { sessionId } });
  console.log(skills.filter(skill => skill.name.startsWith('zhixing-')).map(skill => skill.name));
} finally { await dsh.close(); }
```

## Gotchas

- `installed` 和 `enabled` 是原生安装配置；是否被当前会话加载需要原生能力列表或加载记录确认。测试用新会话，避免把旧会话的缓存误当作安装失败。
- 用户可添加公开 GitHub Codex 市场或公开 GitHub Raw DSH 索引。操作者预设来源保留实例配置。Codex 记录选定提交，DSH 记录索引并对具体安装包核对固定提交。账号目录、打开中书的客户端与工作区目录都不参与安装。页面的安装结果也不代表已授权外部服务。
- 「结果待核实」保留原始操作。原生证据无法确定时继续保持待核实，由操作者检查目标原生 Host；另一个 Harness 可以继续使用。

## Implementation and regression

[私有 API 与操作记录](../../src/server/plugins.ts)、[Codex 管理进程](../../src/server/codex-plugin-host.ts)、[DSH 原生管理](../../src/server/dsh-plugins.ts)、[页面](../../src/web/plugin-management.tsx)、[Storybook](../../design/stories/PluginLibrary.stories.tsx)、[权限与回执回归](../../test/plugins.test.ts)。
