# syntax=docker/dockerfile:1.7

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

RUN npm prune --omit=dev

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    GAINIUM_MCP_TRANSPORT=stdio \
    GAINIUM_MCP_HOST=0.0.0.0 \
    GAINIUM_MCP_PORT=3000

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

USER node

# HTTP mode is opt-in via GAINIUM_MCP_TRANSPORT=http; EXPOSE documents the port
# used in that mode without forcing it.
EXPOSE 3000

CMD ["node", "dist/server.js"]
