# 中书 · Zhongshu

A small, self-hosted starting point for a personal agent workbench.

This first tracer contains a browser frontend and a Node.js backend. The page
reads `/api/version`; `/api/health` reports process health. It serves **no private
data and has no agent, file-management or command-execution capability**. It is
intentionally public. Authentication must be added before private features.

## Develop

Use Node.js 24 (the exact version is in `.node-version`). There are no third-party
runtime dependencies.

```sh
npm ci
npm test
npm run dev
```

Open `http://127.0.0.1:3000`. The page should report that the frontend and backend
are connected, with revision `development`. Local development needs no production
credentials or server access.

## Project guides

- [Agent working agreement](AGENTS.md): boundaries, autonomy and task-based navigation.
- [Documentation](docs/README.md): task-based paths to architecture decisions, quality criteria and delivery plans.
- [Architecture](docs/architecture.md): the current implementation and its code entry points.
- [Development](docs/development.md): local builds, containers, verification and PRs to `main`.

The guides are currently written in Chinese.
Product code and deployment interfaces are portable; actual deployment settings
and operator records belong outside this repository.

MIT licensed. Node's official base image and GitHub Actions are pinned by digest
or commit. Review and update these pins periodically.
