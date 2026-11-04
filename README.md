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

Set `workspaceRoots` to enable adding directories from the workbench. The app and intended Harnesses must see the same directory tree at the same absolute path. The app account needs permission to create directories and the intended Harness accounts must be able to enter them. Keep root ancestors stable during execution. Directory identity uses the filesystem device, inode and birth time, so choose storage that reports birth time and preserves identity across normal restarts. Root entries must be disjoint and must stay outside the app data tree. Existing `workspaces` keep their IDs and remain available while configured. The dedicated DSH editing configuration requires a single workspace and excludes `workspaceRoots`.

Workspace files are readable by default. For Codex-only workspaces, set `"managedWrites": true` only after verifying that the instance coordinates every writer. DSH editing requires a dedicated instance with exactly one registered workspace, no Codex connection, `managedWrites: true`, and an absolute `dsh.maintenanceExecutable` bound to that workspace's Host. Keep the executable and its parent directories under operator control. It must be owned and executable by the application account, and cannot be a symlink or writable by other users.

The controller takes one argument, `status`, `pause`, or `resume`, and prints only `{"state":"online"}` or `{"state":"paused"}`. It must report paused only after the dedicated Host and its entire process tree have exited. That state must survive application restarts and prevent any out-of-band Host start or other writer until resume. Resume reopens the same Host data and refreshes the launch file. On uncertainty the controller exits nonzero. Keep Host lifecycle authority in the controller and keep privileged management interfaces and credentials away from the Host and browser. On platforms without Linux directory descriptors via `/proc/self/fd`, use stable directory trees whose ancestors cannot be concurrently replaced. See [workspace files](docs/features/workspace-files.md).

Codex uses a Unix socket; the operator owns its directory and permissions. DSH's `launchFile` must be a regular `0600` file owned by the runtime account, with a parent directory not writable by group or others; it must not be a symlink or a public address. The Host atomically updates it after a restart, and the adapter re-reads it on reconnect.

Current compatibility is Codex CLI `0.166.0-alpha.5.1` and DSH `0.2.1-rc.4`. Re-run the real integration path after upgrading either host; a passing schema check is not a compatibility proof.

For a production build, run `npm run build`, set `ZHONGSHU_ORIGIN` to the public HTTPS origin, then `npm start`.

## Instance plugin management

The workbench manages the configured native Codex and DSH instances separately. Use dedicated native data for each deployment. A browser only needs access to the Zhongshu instance. The workbench discovers packages from operator-approved native sources and applies changes to that Harness's instance. See the [plugin management map](docs/features/plugin-management.md).

**Codex.** Run the Codex plugin manager beside the dedicated App Server using the same instance `HOME`, `CODEX_HOME` and pinned CLI version. Configure the native marketplace in that profile first and pin its checkout to the reviewed commit. In the dedicated native profile, run `codex plugin marketplace add --ref <commit> <https-git-url>` and use `codex plugin marketplace list --json` to read the registered name. The manager accepts Git marketplaces and packages pinned to Git commits. OpenAI account catalogs are outside its write scope. Add `pluginManagerSocketPath` to the app's existing `codex` connection; `socketPath` must still identify the same App Server socket. Both processes must be able to identify that socket. Give the Zhongshu application access to the manager socket over a private mount; keep that socket and the manager configuration out of the agent's execution environment. Do not share a desktop or other deployment's Codex state directory.

Save a private operator JSON file, for example:

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

Use real paths without symlinks. The socket directory, home and Codex state must be owned by the manager process user and mode `0700`; keep the config at `0600`. Start the manager using the product build and production dependencies:

```sh
ZHONGSHU_CODEX_PLUGIN_CONFIG=/run/operator/codex-plugin-manager.json node dist/server/codex-plugin-host.js
```

**DSH.** Use Web Host `0.2.1-rc.5` for this plugin management path. Enable `@deepseek-ai/dsh-experimental-plugin-market-bundle` in the Web profile and install the package manager required by the native Host (for example pnpm). In the dedicated profile, set the approved HTTPS index through the native market UI or the Web Host method `pluginMarket/setIndexes` with `{ "urls": ["https://example.com/immutable-index.json"] }`. Keep the Host's global data specific to this deployment. In the app config add `pluginSources` under the existing `dsh` entry, for example `[{ "label": "Approved market", "url": "https://example.com/immutable-index.json" }]`. The URL must match the native index. The workbench allows pinned Git packages from that approved source. A native response that calls for a restart is shown as pending until the operator restarts the target Host and the workbench verifies its new state.

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
