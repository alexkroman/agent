# AssemblyAI Support Agent

A voice-powered support agent for [AssemblyAI](https://assemblyai.com), built
with [aai](https://github.com/anthropics/aai).

## Getting started

```sh
aai deploy         # Bundle and deploy
aai deploy -y      # Deploy without prompts
```

## Ingesting documentation into the vector store

This agent uses `vector_search` to answer questions from AssemblyAI's docs.
Before it can answer anything, you need to ingest the documentation:

```sh
aai rag https://assemblyai.com/docs/llms-full.txt
```

This fetches AssemblyAI's `llms-full.txt` (a single file containing all their
documentation), chunks it, and upserts the chunks into the vector store.

### Options

```sh
# Custom chunk size (default: 512 tokens)
aai rag https://assemblyai.com/docs/llms-full.txt --chunk-size 256

# Target a specific server
aai rag https://assemblyai.com/docs/llms-full.txt --server http://localhost:3100
```

### How it works

1. `aai rag` fetches the `llms-full.txt` file from the URL
2. It splits the content into chunks (~512 tokens each by default)
3. Each chunk is upserted into the vector store, scoped to this agent
4. At runtime, the `vector_search` builtin tool queries the vector store to find
   relevant documentation chunks for each user question

### Re-ingesting

Run the same `aai rag` command again to update the vector store with fresh
documentation. Chunks are keyed by content, so unchanged pages won't be
duplicated.

## Environment variables

```sh
aai env add MY_KEY # Set a secret (prompts for value)
aai env ls         # List secret names
aai env pull       # Pull names into .env for reference
aai env rm MY_KEY  # Remove a secret
```

Access secrets in your agent via `ctx.env.MY_KEY`.

## Learn more

See `CLAUDE.md` for the full agent API reference.
