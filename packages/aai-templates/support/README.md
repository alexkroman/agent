# AssemblyAI Support Agent

A voice-powered support agent for [AssemblyAI](https://assemblyai.com), built
with [aai](https://github.com/anthropics/aai).

## Getting started

```sh
aai deploy         # Bundle and deploy
aai deploy -y      # Deploy without prompts
```

## Secrets

Access secrets in your agent via `ctx.env.MY_KEY`.

**Local development** — add secrets to `.env` (auto-loaded by `aai dev`):

```sh
MY_KEY=secret-value
```

**Production** — set secrets on the server:

```sh
aai secret put MY_KEY    # Set a secret (prompts for value)
aai secret list          # List secret names
aai secret delete MY_KEY # Remove a secret
```

## Learn more

See `CLAUDE.md` for the full agent API reference.
