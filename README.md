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

Open `http://127.0.0.1:3000`. To run the production layout locally:

```sh
REVISION=$(git rev-parse HEAD) npm run build
npm start
```

`HOST` and `PORT` configure the listener. Frontend requests are same-origin, so
the build is independent of any domain. The web manifest provides a standalone
PWA entry; offline execution and background tasks are not implemented.

## Run a container

```sh
docker build --build-arg REVISION="$(git rev-parse HEAD)" -t zhongshu:local .
IMAGE=zhongshu:local docker compose up -d --wait
```

The example publishes only `127.0.0.1:8787`. Place your HTTPS reverse proxy or
tunnel in front of it. No specific DNS provider is required. `compose.yaml`
supports `IMAGE`, `BIND_ADDRESS`, `PORT`, `MEMORY_LIMIT` and `CPU_LIMIT`; see
`.env.example`. Store real deployment configuration outside your source checkout.

The container runs as a non-root user, with a read-only root filesystem, no host
mounts, no Linux capabilities and small resource limits appropriate to this
version-only application. These are not sizing recommendations for future agents.

## Delivery

`Delivery` runs on pull requests and pushes to `main`:

1. Run the API checks and build; start the actual container and verify its commit.
2. On `main`, publish Linux amd64/arm64 images to `ghcr.io/<owner>/<repository>`.
3. If the repository variable `DEPLOY_ENABLED=true`, deploy the exact resulting
   digest to the configured `production` environment and verify the public API.

Image tags use `sha-<full-commit>`; the published digest appears in the Actions
summary. Source checkout, building and testing occur on GitHub-hosted runners.
The destination only pulls and runs the resulting image.

`Deploy an existing image` can redeploy or roll back to a previously published
digest without rebuilding. Supply its full image reference and matching Git SHA.
Deployments are serialized; a failure during local activation restores the prior
image when one exists. The very first failed activation removes the failed app.
Database migrations are not part of this tracer; future data rollback needs its
own policy.

See [deployment setup](deploy/README.md) for the one-time host and GitHub setup.
Fresh forks run CI and publish under their own namespace; automatic deployment
remains disabled until explicitly configured. This repository contains no real
server addresses, SSH credentials or user deployment history.

## Layout

- `src/public/`: browser assets and manifest.
- `src/server.mjs`: HTTP server with a fixed public-route allowlist.
- `scripts/build.mjs`: portable build and embedded version metadata.
- `Dockerfile`, `compose.yaml`: packaging and a configurable runtime definition.
- `.github/workflows/`: checks, image publication and deployment.
- `deploy/`: administrator-installed, restricted release interface.

MIT licensed. Node's official base image and GitHub Actions are pinned by digest
or commit. Review and update these pins periodically.
