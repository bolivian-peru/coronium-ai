# Multi-stage Dockerfile for coronium-api.
#
# Build:    docker build -t coronium-api:0.1.0 -f apps/api/Dockerfile .
# Run:      docker run -d --name coronium-api -p 5050:5050 \
#             --env-file apps/api/.env \
#             -v $(pwd)/data:/app/data \
#             coronium-api:0.1.0

# ─── Stage 1: dependencies ─────────────────────────────────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Workspace files needed for `pnpm install --filter coronium-api`.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/sdk-ts/package.json ./packages/sdk-ts/
COPY packages/cli/package.json    ./packages/cli/
COPY packages/mcp/package.json    ./packages/mcp/
COPY apps/api/package.json        ./apps/api/
COPY apps/mock-api/package.json   ./apps/mock-api/

RUN pnpm install --frozen-lockfile --filter coronium-api...

# ─── Stage 2: build ────────────────────────────────────────────────────
FROM deps AS build
COPY apps/api ./apps/api
RUN pnpm --filter coronium-api build

# ─── Stage 3: runtime ──────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# better-sqlite3 needs only libstdc++; node-bookworm-slim has it.
ENV NODE_ENV=production
ENV PORT=5050
ENV HOST=0.0.0.0
ENV DATABASE_PATH=/app/data/coronium.db

RUN useradd --system --create-home --uid 1001 coronium && mkdir -p /app/data && chown -R coronium:coronium /app

COPY --from=build --chown=coronium:coronium /repo/apps/api/dist ./dist
COPY --from=build --chown=coronium:coronium /repo/apps/api/src/db/schema.sql ./dist/db/schema.sql
COPY --from=build --chown=coronium:coronium /repo/apps/api/package.json ./package.json
COPY --from=build --chown=coronium:coronium /repo/apps/api/node_modules ./node_modules

USER coronium
EXPOSE 5050

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
