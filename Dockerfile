# ── Stage 1: Builder ──────────────────────────────────────────────────
ARG NODE_BUILDER_IMAGE=node:22-bookworm
ARG NODE_RUNTIME_IMAGE=node:22-bookworm-slim
FROM ${NODE_BUILDER_IMAGE} AS builder

WORKDIR /build

# System deps for native modules (node-pty, sharp, bcrypt, better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests first for layer caching.
# Root, UI, and SDK are the workspaces needed by the Web image.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
# NOTE: edgeclaw-memory-core is consumed via a local `file:` dependency.
# Copy the full directory before install so pnpm snapshots complete sources/types.
COPY src/context/memory/edgeclaw-memory-core/ src/context/memory/edgeclaw-memory-core/
COPY ui/package.json ui/
COPY packages/sdk/package.json packages/sdk/
COPY ui/scripts/ ui/scripts/

# Install only the Web/Gateway workspaces. Shared appearance sources do not
# require the Electron workspace or desktop dependencies in this image.
# Pin pnpm so CI builds do not pick up stricter build-script policy changes
# before the lockfile/workspace config is updated.
RUN npm install -g pnpm@10.32.1 \
    && pnpm --version \
    && HUSKY=0 pnpm install --frozen-lockfile --filter pilotdeck --filter pilotdeck-ui --filter @pilotdeck/sdk

# Copy all source files
COPY src/ src/
COPY scripts/ scripts/
COPY ui/ ui/
COPY packages/sdk/ packages/sdk/
COPY apps/desktop/src/lightAppearance.ts apps/desktop/src/interfacePreferences.ts apps/desktop/src/
COPY skills/ skills/

# Build edgeclaw-memory-core (src/ → lib/)
RUN cd src/context/memory/edgeclaw-memory-core && npm run build

# Build gateway (TypeScript → dist/)
RUN npm run build

# Build UI frontend (Vite → ui/dist/)
COPY products/pilotdeck-staffdeck-sop/profiles/ products/pilotdeck-staffdeck-sop/profiles/
ARG PILOTDECK_BUILD_PROFILE=products/pilotdeck-staffdeck-sop/profiles/native.yaml
ARG PILOTDECK_DISABLE_LOCAL_AUTH=1
RUN PILOTDECK_CONFIG_PATH=/build/${PILOTDECK_BUILD_PROFILE} \
    PILOTDECK_DISABLE_LOCAL_AUTH=${PILOTDECK_DISABLE_LOCAL_AUTH} npm --prefix ui run build


# ── Stage 2: Runtime ─────────────────────────────────────────────────
FROM ${NODE_RUNTIME_IMAGE}

WORKDIR /app

# Runtime system dependencies + tsx for the UI server
RUN apt-get update && apt-get install -y --no-install-recommends \
    ripgrep git curl procps \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g tsx

# Copy built application from builder
COPY --from=builder /build/package.json /build/pnpm-lock.yaml ./
COPY --from=builder /build/tsconfig.json ./
COPY --from=builder /build/node_modules/ node_modules/
COPY --from=builder /build/packages/sdk/package.json packages/sdk/package.json
COPY --from=builder /build/packages/sdk/dist/ packages/sdk/dist/
COPY --from=builder /build/packages/sdk/node_modules/ packages/sdk/node_modules/
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
COPY --from=builder /build/products/pilotdeck-staffdeck-sop/profiles/ products/pilotdeck-staffdeck-sop/profiles/

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
