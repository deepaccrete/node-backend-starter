# ── Build/deps stage ──────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Run as a non-root user. The base image ships `node` (uid 1000) for exactly
# this; a container that runs as root turns any RCE into host-level access.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

# Writable paths the app creates at boot.
RUN mkdir -p logs src/public && chown -R node:node logs src/public

USER node
EXPOSE {{PORT}}

# The container is only "healthy" once the DB answers — /health/ready checks it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:{{PORT}}/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
