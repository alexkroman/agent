FROM node:22-slim

WORKDIR /app

# Install pnpm and git (needed for simple-git)
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate && \
    apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Copy workspace config and lockfile first (layer cache)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/aai-slack/package.json packages/aai-slack/

# Install dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @alexkroman1/aai-slack

# Copy source
COPY packages/aai-slack/ packages/aai-slack/
COPY tsconfig.json ./

EXPOSE 3000

CMD ["node", "--experimental-strip-types", "packages/aai-slack/src/index.ts"]
