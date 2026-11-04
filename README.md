# 中书 · Zhongshu

A small, self-hosted starting point for a personal agent workbench.

The React frontend and Fastify application provide a single-administrator private entry backed by SQLite. It connects to independently managed Codex and DSH hosts for persistent conversations, workspace tasks and recovery after leaving the page. Health and build-version endpoints remain public.

## Develop

Use Node.js 24 (the exact version is in `.node-version`). Dependencies are pinned in `package-lock.json`; installation does not run package lifecycle scripts.

```sh
npm ci --ignore-scripts
npm run admin -- init
npm test
npm run dev
```

Open `http://127.0.0.1:3000` and sign in with the password entered during local initialization. The development launcher enables HTTP only on loopback. Data is stored outside this checkout; set `ZHONGSHU_DATA_DIR` for a separate instance. Local development needs no production credentials or server access.

To execute agent tasks, configure an existing native host and an allowed workspace as described below. Without this operator configuration, sign-in works but no execution workspace is available.

## Harness connections

Set `ZHONGSHU_HARNESS_CONFIG` to an absolute, operator-owned `0600` file. The workspace list is an allowlist, not an OS sandbox. Paths are normalized and must not overlap the data directory. Do not put connection secrets in the browser, git or logs.

```json
{
  "workspaces": [
    { "id": "notes", "label": "Notes", "directory": "/srv/workspaces/notes" }
  ],
  "workspaceRoots": [
    { "id": "shared", "label": "Shared folders", "directory": "/srv/workspaces" }
  ],
  "codex": { "socketPath": "/run/private-codex/app.sock" },
  "dsh": { "launchFile": "/run/private-zhongshu/dsh-launch" }
}
```

`workspaceRoots` enables adding directories from the workbench. The application and Harness must see the same absolute workspace paths. Keep directory ancestors stable and outside the application data tree. Existing `workspaces` retain their IDs. A direct `codex`/`dsh` connection supports reading and execution; it does not grant managed file editing. Legacy `managedWrites: true` cannot grant that permission, and `maintenanceExecutable` must be migrated before startup.

Codex uses a private Unix socket. DSH's `launchFile` must be an operator-owned regular `0600` file in a private directory, without symlinks or a public address. Direct connections may configure `boundedHistory: { nativeRoot, cacheRoot, maxCacheBytes }`; DSH also needs `boundedState: true` and the matching compatibility plugin. Without those readers, the direct compatibility path does not meet the long-history performance profile.

### Managed Host deployment

受管编辑使用专用 Linux Docker Host。工作台之外的客户端也只能经过网关；原生 socket/launch URL、Docker socket 和管理凭据不得暴露给浏览器或其他原生客户端。操作者必须关闭未登记的原生计划任务及其他自动入口，不能另设 systemd、Compose 或 Docker 自动重启原生容器。原生进程、工具和后台子进程都在同一容器内；普通停止当前轮仍不等于整个 Host 退出。

在上述配置中，用 `managedHosts` 替代相应的直接 `codex`/`dsh` 配置，同一 Harness 只能配置一个受管 Host。下面是路径结构示例，镜像摘要须替换为操作者核验的不可变镜像；镜像应包含 Node 24、产品 `dist`/生产依赖及固定版本的原生 Harness。

```json
{
  "workspaces": [{ "id": "notes", "label": "Notes", "directory": "/srv/workspaces/notes" }],
  "workspaceWriterDirectory": "/srv/zhongshu-control/file-writer",
  "managedHosts": [{
    "groupId": "codex-host", "harnessId": "codex",
    "workspaceIds": ["notes"], "workspaceRootIds": [],
    "ledgerDirectory": "/srv/zhongshu-control/codex",
    "docker": {
      "socketPath": "/var/run/docker.sock", "ownershipPort": 39781,
      "image": "operator/native-host@sha256:<verified-64-hex-digest>",
      "argv": ["/usr/local/bin/node", "/app/dist/server/managed-harness-server.js", "/runtime/native.json"],
      "user": "1000:1000", "network": "bridge",
      "mounts": [
        { "source": "/srv/workspaces/notes", "target": "/srv/workspaces/notes", "kind": "workspace" },
        { "source": "/srv/native/codex-data", "target": "/data", "kind": "data" },
        { "source": "/srv/native/codex-runtime", "target": "/runtime", "kind": "runtime", "readOnly": true },
        { "source": "/srv/native/codex-ipc", "target": "/ipc", "kind": "runtime" }
      ]
    },
    "native": { "socketPath": "/srv/native/codex-ipc/native.sock", "tokenFile": "/srv/native/codex-ipc/native.token" },
    "gateway": { "socketPath": "/run/zhongshu-private/codex.sock", "tokenFile": "/run/zhongshu-private/codex.token" }
  }]
}
```

两个 token 文件分别保存独立随机 32 字节的 base64url 编码（43 字符）；配置/凭据为同一操作者所有的 `0600` 文件，IPC 和账本目录为 `0700`。网关与容器使用相同非 root UID。`workspaceWriterDirectory` 与每个 `ledgerDirectory` 必须独立于可恢复的产品数据库，恢复主库时保留它们及原生数据。文件写者路径已绑定到每个 Host 的持久配置摘要，不能换一个空目录便认定旧写者已退出。尚未核实的保存和派发会继续阻止不安全的恢复。

`workspaceIds`/`workspaceRootIds` 的真实目录必须与 `kind: workspace` 的挂载范围一致；相交的可写挂载自动形成冲突组。辅助 data/runtime 可写挂载不得覆盖工作区。Host 固定非 root、只读根文件系统、去除全部 capabilities、禁止提权、无主机 PID 命名空间、无发布端口、`restart=no`，默认 2 CPU/2 GiB/256 PID。网关必须运行在 Linux 本地 ext4/btrfs/xfs/tmpfs/overlay 文件系统上，并提供 root 所有、不可由普通用户改写的 `/usr/bin/flock`。父进程持有 `ledgerDirectory/owner.lock` 的文件描述符；固定 helper 对继承描述符加内核锁后退出，锁继续由父进程持有，跨网络/PID/容器命名空间互斥。只有所有在途 Host effects 结束后关闭描述符，或父进程真正退出，才会释放；禁止删除锁文件。`ownershipPort` 是附加 loopback 存活锁，不是 API 端口。不要复用端口、账本或组 ID。

Linux 本地 bind mount 为默认；Docker Desktop 验证须把私有 IPC 放在 Linux 本地 volume，不能降低 Unix socket 权限检查以兼容共享 macOS 目录。mount 可增加 `volume: { name, subpath }`：仅接受 Docker `local` driver/`local` scope、无额外 driver 选项的卷，且 `source` 必须等于 Docker inspect 的 Mountpoint 加 subpath，并在网关文件系统同路径可见。子目录须已存在；远程卷不是此部署 profile。

仓库 [Dockerfile](Dockerfile) 已安装固定版本的独立 `flock` 二进制；Alpine 默认指向 BusyBox 的符号链接不满足此检查。直接运行 Node 网关时，同样需要操作者提供符合上述条件的程序。

容器内 `native.json` 是另一份私有操作者配置，由固定 argv 启动，无 shell 拼接：

```json
{
  "socketPath": "/ipc/native.sock", "tokenFile": "/ipc/native.token",
  "native": {
    "id": "codex", "socketPath": "/data/app.sock",
    "boundedHistory": { "nativeRoot": "/data/codex-home", "cacheRoot": "/data/reading-cache" }
  },
  "process": {
    "executable": "/opt/codex/codex",
    "args": ["app-server", "--listen", "unix:///data/app.sock"],
    "cwd": "/srv/workspaces/notes",
    "environment": { "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/data/home", "CODEX_HOME": "/data/codex-home" }
  }
}
```

DSH 的 `native` 改为 `{ id: "dsh", launchFile, boundedHistory: { nativeRoot, cacheRoot }, boundedState: true }`，`nativeRoot` 指向含编码工作区目录的原生 session 根。原生启动器须原子更新 launch 文件；rc.4 配置必须禁用 `session-turn-outline`，装载 [bounded-host-plugin](src/harness/dsh/bounded-host-plugin.ts) 的编译输出并指向正确 `runtimeRoot`。容器入口强制 `managedExecution: true`：断线不会由 adapter 后台重新激活会话，后续 state/watch/reconcile 要重新经过网关许可。

网关私有 Unix HTTP 接受 Bearer 认证的 `POST /execute`，请求仅含已有业务 ID，例如 `{ "kind": "operation", "operationId": "<uuid>" }`；它从可信仓储重建输入和绑定，核验冻结集合与当前 generation/epoch，再先落一次性账本后转发。`create` 使用 conversationId；`wake`、观察及基线也各有持久许可。未知结果保持未知，同 ID 不自动重发。创建已在控制器记下 early binding、但主库回执失败时，“查询原生结果”或私有 `POST /recover-create { conversationId }` 只读控制器账本并核验后补回绑定，绝不再次调用原生 create；没有持久身份时仍保留未知。其他客户端若要创建新工作，应先使用已认证的工作台 API 持久受理，不能直接接原生私有接口。watch 通过工作台 SSE 观察。

操作者 `POST /control` 支持 `inspect`、`capacity`，以及带稳定 requestId、expected generation/epoch 的 `fence/quiesce/resume`；封门/收束还必须匹配 frozenSetId。正常编辑从工作台状态机发起。控制器只有独立验证整个容器退出、PID 为 0 且无自动重启后才给出 quiescent；恢复重开同一个容器和数据。直接调用未完成的控制操作同样可能留下未知意图，不能靠重启清除。

产品归档的未发布正文暂存预算由 `ZHONGSHU_STORAGE_TRANSIENT_BYTES` 控制，默认 512 MiB；超额暂停该正文并可在扩容后续传，未知 stage 不按超时删除，已发布旧版本不属于暂存清理范围。产品容量还计入数据目录中的缓存；独立 Host/文件写者账本保持各自身份与恢复边界。

每个 Host 的 `ledgerCapacity` 默认 2 GiB 配额、64 MiB 受理预留及 512 MiB 磁盘空闲线；字段为 `quotaBytes/reserveBytes/minimumFreeBytes`。统计包括数据库与 WAL，80% 时 warning，受理线处拒绝新派发；保留旧回执/未知记录和控制、停止、settle 的预留。`capacity` 返回无路径的计数和状态，操作者监控并扩容；不会自动删除幂等身份。真实 ENOSPC 仍可能使控制结果未知，此时保留门禁。已存档正文继续由产品存储读取；Host 停止期间未完成的原生回填显示暂停/错误并在恢复后重试，不会标记为已完整存档。

独立文件写者同样默认 2 GiB 配额、64 MiB 预留、512 MiB 空闲线，可分别设置 `ZHONGSHU_WORKSPACE_WRITER_QUOTA_BYTES`、`ZHONGSHU_WORKSPACE_WRITER_RESERVE_BYTES`、`ZHONGSHU_WORKSPACE_WRITER_FREE_BYTES`。新保存达到受理线时被拒绝；已有 intent 的核实和旧回执读取仍可使用预留，不会按时间清理未知保存记录。

受管插件管理在对应 `managedHosts` 项设置 `pluginManagement: true`，并在容器原生配置提供同一 Harness 的插件后端，详见[插件接入](docs/features/plugin-management.md#准备原生连接)。安装、启停、卸载和市场源变更各有持久业务 ID 与 Host 级受理许可，受理与封门共用一个 SQLite 事务边界；不借用聊天身份。已受理变更进入冻结集合，未知结果只能核对；停止期间读插件目录不会重启原生 Host。

受管执行回归入口为 `node --test test/execution-host.test.ts test/managed-harness-rpc.test.ts test/managed-harness.test.ts test/managed-harness-config.test.ts`。这些测试的原生端点是合成替身；真实 Docker 进程树收束测试另用 `ZHONGSHU_TEST_DOCKER_SOCKET` 和 `ZHONGSHU_TEST_DOCKER_IMAGE` 指定隔离环境运行 `test/execution-host-docker.test.ts`。实际两 Harness 的创建、原生执行、封门、退出实证、文件保存和同绑定恢复仍须分别走[执行](docs/features/execution.md)与[工作区文件](docs/features/workspace-files.md)地图，保留现场证据。

Current compatibility is Codex CLI `0.166.0-alpha.5.1` and DSH `0.2.1-rc.4`. Re-run the real integration path after upgrading either host; a passing schema check is not a compatibility proof.

To enable instance plugin management, see the [native connection setup](docs/features/plugin-management.md#准备原生连接).

For a production build, run `npm run build`, set `ZHONGSHU_ORIGIN` to the public HTTPS origin, then `npm start`.

## UI development

```sh
npm run tokens            # regenerate CSS after editing the authored tokens
npm run storybook         # http://127.0.0.1:6006, no product login or native host
npm run build:storybook   # .artifacts/storybook, development artifact only
npm run check:release     # verify the most recent product build inventory
```

The [UI architecture](docs/architecture.md#界面与设计系统) describes the token, control, pattern and feature boundaries. The [interface map](docs/features/interface.md) covers interaction, component states and release-boundary verification. Storybook renders the product's actual components; its accepted reference prototype is a separate historical reference under `design/reference/`, not a product entry.

Product builds reject development imports and unreviewed public assets. Storybook outputs never go into `dist`. The Docker build copies an explicit input list, installs production dependencies in the runtime stage and verifies the final artifact inventory. These checks also run in CI. Deliberate changes to public assets require updating `scripts/product-assets.json` and reviewing the changed file, not just accepting a new hash.

## Container

```sh
docker build -t zhongshu:local .
IMAGE=zhongshu:local docker compose --project-name zhongshu-local up -d --wait
# http://127.0.0.1:8787
IMAGE=zhongshu:local docker compose --project-name zhongshu-local down
```

`scripts/check-container.mjs` runs against a fresh temporary Compose project and verifies real login, production cookie attributes, session survival after container replacement, online backup, restore to a new directory, and old-session revocation. It is not for a real instance.

`MEMORY_LIMIT` and `CPU_LIMIT` configure the application container. The Compose defaults are a small initial configuration, not the measured large-history profile. For scale acceptance, use the budgets in [performance-profile.ts](test/support/performance-profile.ts); budget the independent native Hosts separately and verify the target machine. An unhealthy gateway can require an explicit process restart; the current worker failure and operation-recovery behavior is described in the [architecture](docs/architecture.md#边界).

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run check:docs
```

`check:docs` verifies relative links, document reachability, feature-map headings, spec front matter and ADR numbering. It does not judge prose.

## Project guides

- [Agent working agreement](AGENTS.md): boundaries, autonomy, task routing and definition of done.
- [Documentation entry](docs/README.md): the five document classes and their indexes.
- [Architecture](docs/architecture.md): current modules, boundaries and code entry points.
- [Feature maps](docs/features/README.md): user paths, implementation entries and how to verify affected behavior.
- [Specs](docs/spec/README.md): current slices, status ledger and acceptance exit.
- [ADRs](docs/adr/): decisions that are hard to reverse, surprising or a real trade-off.

Product documentation is written in Chinese; code and comments are English. The repository is MIT licensed. Node's official base image and GitHub Actions are pinned by digest or commit; review and update these pins periodically.
