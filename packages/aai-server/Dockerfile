FROM node:22-slim AS build

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

# Copy workspace config and lockfile first (layer cache)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/aai/package.json packages/aai/
COPY packages/aai-server/package.json packages/aai-server/

# Install dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts --prod=false

# Copy source
COPY packages/aai/ packages/aai/
COPY packages/aai-server/ packages/aai-server/
COPY tsconfig.json ./

# Build SDK + server + harness
RUN pnpm --filter @alexkroman1/aai build && \
    pnpm --filter @alexkroman1/aai-server build

# --- Production image ---
FROM node:22-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/aai/package.json packages/aai/
COPY packages/aai-server/package.json packages/aai-server/

# esbuild needs its install script to set up the platform-specific binary.
# secure-exec uses esbuild at runtime to compile isolate code.
RUN pnpm install --frozen-lockfile --ignore-scripts --prod && \
    node node_modules/.pnpm/esbuild@*/node_modules/esbuild/install.js

COPY --from=build /app/packages/aai/dist/ packages/aai/dist/
COPY --from=build /app/packages/aai-server/dist/ packages/aai-server/dist/

EXPOSE 8080

CMD ["node", "packages/aai-server/dist/index.mjs"]
