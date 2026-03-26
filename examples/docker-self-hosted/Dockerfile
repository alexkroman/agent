FROM node:22-slim

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install

# Copy application code
COPY agent.ts server.ts ./

# Expose default port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => { if (!r.ok) process.exit(1) })"

# Run the server
CMD ["node", "server.ts"]
