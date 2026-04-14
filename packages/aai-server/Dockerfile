# Production Dockerfile for aai-server with gVisor sandbox isolation.
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

# ── Production stage ─────────────────────────────────────────────────────────

FROM node:24-slim

WORKDIR /app

# Install gVisor (runsc) and Deno — both need curl
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && curl -fsSL "https://storage.googleapis.com/gvisor/releases/release/latest/x86_64/runsc" \
       -o /usr/local/bin/runsc \
    && chmod +x /usr/local/bin/runsc \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && apt-get remove -y curl unzip && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/aai/package.json packages/aai/
COPY packages/aai-ui/package.json packages/aai-ui/
COPY packages/aai-server/package.json packages/aai-server/

RUN pnpm install --frozen-lockfile --ignore-scripts --prod

COPY --from=build /app/packages/aai/dist/ packages/aai/dist/
COPY --from=build /app/packages/aai-ui/dist/ packages/aai-ui/dist/
COPY --from=build /app/packages/aai-server/dist/ packages/aai-server/dist/

ENV NODE_ENV=production
ENV GUEST_HARNESS_PATH=/app/packages/aai-server/dist/guest/deno-harness.mjs

EXPOSE 8080

CMD ["node", "packages/aai-server/dist/index.mjs"]
