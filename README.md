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
