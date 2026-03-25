FROM node:24-slim AS build

WORKDIR /app

# Install pnpm + build tools for native modules (isolated-vm node-gyp fallback)
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate && \
    apt-get update && apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Copy workspace config and lockfile first (layer cache)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/aai/package.json packages/aai/
COPY packages/aai-server/package.json packages/aai-server/

# Install dependencies and build isolated-vm native binary
RUN pnpm install --frozen-lockfile --ignore-scripts --prod=false && \
    pnpm rebuild isolated-vm

# Copy source
COPY packages/aai/ packages/aai/
COPY packages/aai-server/ packages/aai-server/
COPY tsconfig.json ./

# Build SDK + server + harness
RUN pnpm --filter @alexkroman1/aai build && \
    pnpm --filter @alexkroman1/aai-server build

# --- Production image ---
FROM node:24-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/aai/package.json packages/aai/
COPY packages/aai-server/package.json packages/aai-server/

RUN pnpm install --frozen-lockfile --ignore-scripts --prod

# Copy the compiled isolated-vm native binary from the build stage
COPY --from=build /app/node_modules/.pnpm/isolated-vm@*/node_modules/isolated-vm/out/ node_modules/.pnpm/isolated-vm@6.0.2/node_modules/isolated-vm/out/

COPY --from=build /app/packages/aai/dist/ packages/aai/dist/
COPY --from=build /app/packages/aai-server/dist/ packages/aai-server/dist/

EXPOSE 8080

CMD ["node", "packages/aai-server/dist/index.mjs"]
