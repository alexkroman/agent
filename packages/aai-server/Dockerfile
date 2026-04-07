# --- Build nsjail from source (not in Debian bookworm repos) ---
FROM node:22-slim AS nsjail-builder

RUN apt-get update && \
    apt-get install -y \
      autoconf bison flex gcc g++ git libprotobuf-dev \
      libnl-route-3-dev libtool make pkg-config protobuf-compiler && \
    rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch 3.6 https://github.com/google/nsjail.git /nsjail && \
    cd /nsjail && make -j$(nproc)

# --- Build app ---
FROM node:22-slim AS build

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

# Copy workspace config, lockfile, and patches first (layer cache)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/aai/package.json packages/aai/
COPY packages/aai-server/package.json packages/aai-server/

# Install dependencies (patches applied by pnpm automatically)
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

# Install nsjail runtime dependencies + nsjail binary
RUN apt-get update && \
    apt-get install -y --no-install-recommends libprotobuf32 libnl-route-3-200 && \
    rm -rf /var/lib/apt/lists/*
COPY --from=nsjail-builder /nsjail/nsjail /usr/local/bin/nsjail

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
