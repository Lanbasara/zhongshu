# 中书 · Zhongshu

A small, self-hosted starting point for a personal agent workbench.

The React frontend and Fastify application provide a single-administrator private
entry backed by SQLite. Health and build-version endpoints remain public.
Agent execution and workspace features are developed as subsequent slices.

## Develop

Use Node.js 24 (the exact version is in `.node-version`). Dependencies are pinned
in `package-lock.json`; installation does not run package lifecycle scripts.

```sh
npm ci --ignore-scripts
npm run admin -- init
npm test
npm run dev
```

Open `http://127.0.0.1:3000` and sign in with the password entered during local
initialization. The development launcher enables HTTP only on loopback. Data is
stored outside this checkout; set `ZHONGSHU_DATA_DIR` for a separate instance.
Local development needs no production credentials or server access.

For a production build, run `npm run build`, set `ZHONGSHU_ORIGIN` to the public
HTTPS origin, then `npm start`. See [identity and data operations](docs/identity.md)
before initializing a deployed instance or restoring data.

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
