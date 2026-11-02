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
  "codex": { "socketPath": "/run/private-codex/app.sock" },
  "dsh": { "launchFile": "/run/private-zhongshu/dsh-launch" }
}
```

Codex uses a Unix socket; the operator owns its directory and permissions. DSH's `launchFile` must be a regular `0600` file owned by the runtime account, with a parent directory not writable by group or others; it must not be a symlink or a public address. The Host atomically updates it after a restart, and the adapter re-reads it on reconnect.

Current compatibility is Codex CLI `0.164.0-alpha.11.1` and DSH `0.2.1-rc.4`. Re-run the real integration path after upgrading either host; a passing schema check is not a compatibility proof.

For a production build, run `npm run build`, set `ZHONGSHU_ORIGIN` to the public HTTPS origin, then `npm start`.

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
