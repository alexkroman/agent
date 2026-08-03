# aai

Voice agent development kit. Define agents in TypeScript, deploy anywhere.

Run once with `npx`:

```sh
npx @alexkroman1/aai-cli@latest
```

Or install globally and use the `aai` command:

```sh
npm i -g @alexkroman1/aai-cli
aai
```

## Self-hosting

Agents don't require the managed platform: `@alexkroman1/aai/runtime`
exposes the same engine `aai dev` runs. Define an agent with `agent()`,
build a runtime with `createRuntime()`, and serve voice sessions from your
own Node process with `createServer()` — or wire `runtime.startSession(ws)`
into an existing WebSocket stack. See
[examples/self-hosted-server](./examples/self-hosted-server) for a runnable
~70-line setup.

## Documentation

- [API reference](https://alexkroman.github.io/agent/) — generated docs
  for the published SDK packages
- [CLAUDE.md](./CLAUDE.md) — for humans and agents working on the aai
  framework itself
- [scaffold/CLAUDE.md](./packages/aai-templates/scaffold/CLAUDE.md)
  — for humans and agents building voice agents
