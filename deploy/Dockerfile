# The Studio API, as one image.
#
#   builder   installs everything, bundles src/index.ts (and the engine it
#             imports) into dist/index.mjs with esbuild
#   runtime   production dependencies and the bundle; no TypeScript, no
#             toolchain, runs as the unprivileged `node` user
#
# Built in CI and pushed to ghcr.io; the server only ever pulls it. The web
# app is not in this image -- it is deployed to Vercel.

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/studio/package.json      apps/studio/
COPY apps/studio-api/package.json  apps/studio-api/
COPY apps/studio-web/package.json  apps/studio-web/
RUN npm ci --no-audit --fund=false
COPY tsconfig.base.json ./
COPY apps/studio      apps/studio
COPY apps/studio-api  apps/studio-api
RUN npm run bundle --workspace apps/studio-api \
 && test -f apps/studio-api/dist/index.mjs

# Production dependencies only, in a clean tree.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/studio/package.json      apps/studio/
COPY apps/studio-api/package.json  apps/studio-api/
COPY apps/studio-web/package.json  apps/studio-web/
RUN npm ci --omit=dev --workspace apps/studio-api --include-workspace-root=false --no-audit --fund=false

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4300 \
    STUDIO_DATA_DIR=/data \
    STUDIO_UPLOAD_DIR=/data/uploads
COPY --from=deps    /app/node_modules              ./node_modules
COPY --from=builder /app/apps/studio-api/dist      ./apps/studio-api/dist
COPY --from=builder /app/apps/studio-api/package.json ./apps/studio-api/package.json
RUN mkdir -p /data/uploads && chown -R node:node /data
VOLUME ["/data"]
USER node
EXPOSE 4300
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4300)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "apps/studio-api/dist/index.mjs"]
