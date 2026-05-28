# ── Stage 1: Builder ──────────────────────────────────────────────────
FROM node:22-bookworm AS builder

WORKDIR /build

# System deps for native modules (node-pty, sharp, bcrypt, better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests first for layer caching.
# ui/ is a npm workspace — root pnpm install handles both.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY src/context/memory/edgeclaw-memory-core/package.json src/context/memory/edgeclaw-memory-core/tsconfig.json src/context/memory/edgeclaw-memory-core/tsconfig.base.json src/context/memory/edgeclaw-memory-core/
COPY ui/package.json ui/
COPY ui/scripts/ ui/scripts/

# Single pnpm install resolves root + workspace (ui) + file dep (edgeclaw-memory-core)
RUN npm install -g pnpm && HUSKY=0 pnpm install --frozen-lockfile 2>&1 | tail -5

# Copy all source files
COPY src/ src/
COPY scripts/ scripts/
COPY ui/ ui/
COPY skills/ skills/

# Build edgeclaw-memory-core (src/ → lib/)
RUN cd src/context/memory/edgeclaw-memory-core && npm run build

# Build gateway (TypeScript → dist/)
RUN npm run build

# Build UI frontend (Vite → ui/dist/)
RUN cd ui && npx vite build


# ── Stage 2: Runtime ─────────────────────────────────────────────────
FROM node:22-bookworm-slim

WORKDIR /app

# Runtime system dependencies + tsx/concurrently for process management
RUN apt-get update && apt-get install -y --no-install-recommends \
    ripgrep git curl procps \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g tsx concurrently

# Copy built application from builder
COPY --from=builder /build/package.json /build/pnpm-lock.yaml ./
COPY --from=builder /build/tsconfig.json ./
COPY --from=builder /build/node_modules/ node_modules/
COPY --from=builder /build/dist/ dist/
COPY --from=builder /build/src/ src/
COPY --from=builder /build/scripts/ scripts/
COPY --from=builder /build/skills/ skills/
COPY --from=builder /build/ui/package.json ui/package.json
COPY --from=builder /build/ui/node_modules/ ui/node_modules/
COPY --from=builder /build/ui/server/ ui/server/
COPY --from=builder /build/ui/dist/ ui/dist/
COPY --from=builder /build/ui/scripts/ ui/scripts/
COPY --from=builder /build/ui/shared/ ui/shared/
COPY --from=builder /build/ui/vite.config.js ui/vite.config.js

# Create pilotdeck home directory
RUN mkdir -p /root/.pilotdeck/projects /root/.pilotdeck/router

# Entrypoint
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV SERVER_PORT=3001
ENV PILOTDECK_GATEWAY_PORT=18789

EXPOSE 3001

ENTRYPOINT ["/docker-entrypoint.sh"]
