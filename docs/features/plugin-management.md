# 实例级插件管理

## Sub-features

| 场景 | 可证伪的结果 |
| --- | --- |
| P01 · 发现和安装 | Codex 与 DSH 有各自的目录。搜索知行，从当前页确认来源和目标再安装，刷新后当前端的原生清单与页面均显示安装版本及启用状态。 |
| P02 · 启停与卸载 | 停用后包仍在，重新启用后恢复，卸载后原生清单中没有安装项；刷新保持一致。 |
| P03 · 范围和授权 | 一端安装或变更不影响另一端、合成工作区文件或独立原生环境。未登录、跨来源、无 CSRF、工作区参数和账号来源的直接变更请求被拒。 |
| P04 · 失联和待生效 | 原生接受但需要重启时显示对应状态；请求结果未知时可读回同一操作，未取得证据前不显示成功，也不自动重新提交。 |

## How to get to it (user POV)

登录工作台，从侧栏打开「插件管理」。选 Codex 或 DSH，再切换「发现」和「已安装」。在「发现」输入知行或来源名称，选条目打开详情。安装、停用、启用、卸载都有确认步骤，范围为「当前实例」，不选工作区。操作后等待状态落定，然后刷新页面、重新打开同一端核对。端点失联或未配置时，页面会区别显示。

## Driving it with Harness

使用[共同入口的 Native 现场](README.md#native真实接入分支)和 [README 的插件配置](../../README.md#instance-plugin-management)。操作者准备独占的 Codex Unix socket、对应管理 socket，以及 DSH `0.2.1-rc.5` Web Host；两者分别配置知行原生市场和固定版本。用没有真实数据的合成工作区；先保留工作区文件摘要及两端原生未安装记录。P03 同账号分支需要操作者提供两个独立且允许实验的原生环境。

- P01：先装其中一端，另一端刷新仍不显示安装。Codex 通过同一 `CODEX_HOME` 的原生 `codex plugin list --marketplace <name> --available --json` 核对 `pluginId`、版本和 `enabled`，并从同一 App Server 用 `skills/list` 查询合成工作区的插件技能。DSH 通过同一 launch 对应的 Web Host `pluginManager/listBundles` 核对包来源、版本、启用和加载条目；再查新会话的能力。原生读回示例见下方。DSH 有可用实验模型时，发送一条调用知行 Skill 的合成请求，核对原生会话事件实际加载的 Skill 内容。
- P02：分别做停用、重新启用、卸载，每次等待页面落定并刷新，再独立读回上面的包清单。停用后包仍在且为 disabled；卸载后当前端没有已安装项。操作其中一端时保留另一端已安装，比较其清单。
- P03：比较工作区摘要和独立原生环境的前后清单。从无登录上下文读私有插件入口应返回 401。从已登录的同源页面读取 `/api/session` 的 `csrfToken`，仅用于同源请求的 `x-csrf-token` 头。对 `/api/private/workbench/plugins/codex/operations` POST JSON `{ id: crypto.randomUUID(), pluginId: "gmail@openai-curated-remote", action: "install" }` 应返回 403 `plugin_action_forbidden`。省略 CSRF 或使用错误 Origin 返回 403，加入 `workspaceId` 返回 400。保留状态和错误码，不记录认证信息。
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
- 已配置来源才提供操作。账号目录、打开中书的客户端与工作区目录都不参与安装。页面的安装结果也不代表已授权外部服务。
- 「结果待核实」保留原始操作。原生证据无法确定时继续保持待核实，由操作者检查目标原生 Host；另一个 Harness 可以继续使用。

## Implementation and regression

[私有 API 与操作记录](../../src/server/plugins.ts)、[Codex 管理进程](../../src/server/codex-plugin-host.ts)、[DSH 原生管理](../../src/server/dsh-plugins.ts)、[页面](../../src/web/plugin-management.tsx)、[权限与回执回归](../../test/plugins.test.ts)。
