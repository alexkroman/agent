# Production Dockerfile for aai-server with gVisor sandbox isolation.
#
# Uses Google's distroless base image — no shell, no package manager,
# no system utilities. An attacker who escapes the container has nothing
# to work with beyond raw syscalls.
#
# gVisor (runsc) is installed in systrap mode — no KVM required.
# Each agent runs in an isolated OCI sandbox with cgroup limits.

# ── Build stage ──────────────────────────────────────────────────────────────

FROM node:24-slim AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

# Copy workspace config and lockfile (layer cache)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/aai/package.json packages/aai/
COPY packages/aai-ui/package.json packages/aai-ui/
COPY packages/aai-server/package.json packages/aai-server/

# Install all deps (dev too — needed for build)
RUN pnpm install --frozen-lockfile --ignore-scripts --prod=false

# Copy source
COPY packages/aai/ packages/aai/
COPY packages/aai-ui/ packages/aai-ui/
COPY packages/aai-server/ packages/aai-server/
COPY tsconfig.json ./

# Build SDK + UI (default client) + server
RUN pnpm --filter aai build \
    && pnpm --filter aai-ui build \
    && pnpm --filter aai-server build

# Install production deps only (separate layer for COPY)
RUN pnpm install --frozen-lockfile --ignore-scripts --prod

# ── Binary stage — fetch runsc and deno ─────────────────────────────────────

FROM node:24-slim AS binaries

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL "https://storage.googleapis.com/gvisor/releases/release/latest/x86_64/runsc" \
       -o /usr/local/bin/runsc \
    && chmod +x /usr/local/bin/runsc \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && rm -rf /var/lib/apt/lists/*

# ── Production stage (distroless — no shell, no utilities) ──────────────────

FROM gcr.io/distroless/nodejs24-debian12

WORKDIR /app

# Copy runsc and deno binaries from the binaries stage
COPY --from=binaries /usr/local/bin/runsc /usr/local/bin/runsc
COPY --from=binaries /usr/local/bin/deno /usr/local/bin/deno

# Copy built application and production dependencies
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/aai/package.json packages/aai/
COPY --from=build /app/packages/aai-ui/package.json packages/aai-ui/
COPY --from=build /app/packages/aai-server/package.json packages/aai-server/
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/packages/aai/node_modules/ packages/aai/node_modules/
COPY --from=build /app/packages/aai-ui/node_modules/ packages/aai-ui/node_modules/
COPY --from=build /app/packages/aai-server/node_modules/ packages/aai-server/node_modules/
COPY --from=build /app/packages/aai/dist/ packages/aai/dist/
COPY --from=build /app/packages/aai-ui/dist/ packages/aai-ui/dist/
COPY --from=build /app/packages/aai-server/dist/ packages/aai-server/dist/

ENV NODE_ENV=production
ENV GUEST_HARNESS_PATH=/app/packages/aai-server/dist/guest/deno-harness.mjs

EXPOSE 8080

# Distroless uses the nodejs binary as entrypoint — pass the script directly
CMD ["packages/aai-server/dist/index.mjs"]
