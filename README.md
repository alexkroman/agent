# aai

Voice agent development kit. Define agents in TypeScript, deploy anywhere.

## Install

```sh
npm install -g @alexkroman1/aai
```

## Quick start

```sh
# Create a new agent
aai init my-agent
cd my-agent

# Start local dev server
aai dev

# Deploy to production
aai deploy
```

## Commands

| Command | Description |
|---------|-------------|
| `aai init [dir]` | Scaffold a new agent project |
| `aai dev` | Start a local development server |
| `aai deploy` | Bundle and deploy to production |
| `aai start` | Start production server from build |
| `aai secret <cmd>` | Manage secrets |
| `aai rag <url>` | Ingest a site into the vector store |
