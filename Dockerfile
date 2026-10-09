# syntax=docker/dockerfile:1

# ── Build stage: compile TypeScript ───────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
ENV HUSKY=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ── Production dependencies only ──────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
ENV HUSKY=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ── Runtime stage ─────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Run as the image's non-root `node` user: a container running as root turns
# any remote code execution into host-level access.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
RUN mkdir -p dist/src/public/uploads && chown -R node:node dist/src/public

USER node
EXPOSE 8001

# Healthy once the database answers. The route lives under the API prefix:
# /api/v1/health/ready (the skill's template probed /health/ready, which never matched).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "const p=process.env.PORT||8001,x=process.env.API_PREFIX||'/api/v1';require('http').get('http://127.0.0.1:'+p+x+'/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Apply migrations first with:  docker compose run --rm api node dist/scripts/migrate.js up
CMD ["node", "dist/server.js"]
