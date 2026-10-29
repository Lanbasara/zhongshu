FROM --platform=$BUILDPLATFORM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY scripts/build.mjs ./scripts/build.mjs
ARG REVISION=development
RUN REVISION="$REVISION" npm run build

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
ARG REVISION=development
LABEL org.opencontainers.image.revision=$REVISION
COPY --from=build /app/dist ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD ["node", "--input-type=module", "-e", "const r = await fetch('http://127.0.0.1:3000/api/health', {signal: AbortSignal.timeout(2000)}); if (!r.ok) process.exit(1);"]
CMD ["node", "server.mjs"]
