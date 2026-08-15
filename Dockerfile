# ── Stage 1: Builder ──────────────────────────────────────────────────
FROM node:26-bookworm AS builder

WORKDIR /build

# System deps for native modules (node-pty, sharp, bcrypt, better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests first for layer caching.
# ui/ is a npm workspace — root pnpm install handles both.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
# NOTE: edgeclaw-memory-core is consumed via a local `file:` dependency.
# Copy the full directory before install so pnpm snapshots complete sources/types.
COPY src/context/memory/edgeclaw-memory-core/ src/context/memory/edgeclaw-memory-core/
COPY ui/package.json ui/
COPY ui/scripts/ ui/scripts/

# Single pnpm install resolves root + workspace (ui) + file dep (edgeclaw-memory-core).
# Pin pnpm so CI builds do not pick up stricter build-script policy changes
# before the lockfile/workspace config is updated.
RUN npm install -g pnpm@10.32.1 \
    && pnpm --version \
    && HUSKY=0 pnpm install --frozen-lockfile

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
RUN cd ui && npm run build


# ── Stage 2: Runtime ─────────────────────────────────────────────────
FROM node:26-bookworm-slim

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

# Create PilotDeck state/workspace directories used by the gateway, UI server,
# permissions, skills/plugins, memory, auth, and router stats.
RUN mkdir -p \
    /root/.pilotdeck/projects \
    /root/.pilotdeck/router \
    /root/.pilotdeck/skills \
    /root/.pilotdeck/plugins \
    /root/.pilotdeck/memory \
    /workspace

# Entrypoint
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV NODE_ENV=production
ENV PILOT_HOME=/root/.pilotdeck
ENV HOST=0.0.0.0
ENV SERVER_PORT=3001
ENV PILOTDECK_GATEWAY_PORT=18789

EXPOSE 3001

ENTRYPOINT ["/docker-entrypoint.sh"]
