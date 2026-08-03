# aai

Voice agent development kit. Define a voice agent as a TypeScript file,
talk to it locally in your browser, deploy it to the managed platform with
one command — or self-host the same runtime.

## Quickstart

```sh
npx @alexkroman1/aai-cli@latest init my-agent
cd my-agent
npx aai dev        # local dev server + browser client
npx aai deploy     # deploy to the managed platform
```

Requires Node.js 24+. `aai init` scaffolds a project from a template
(`aai templates` lists them all) and writes a `.env` for your
`ASSEMBLYAI_API_KEY` — the one key the default pipeline needs for
speech-to-text, the LLM gateway, and text-to-speech alike.

## What an agent looks like

An agent is a directory with an `agent.ts`:

```ts
import { agent, assemblyAIPipeline, tool } from "@alexkroman1/aai";
import { z } from "zod";

const getWeather = tool({
  description: "Get current weather for a city",
  inputSchema: z.object({ city: z.string().describe("City name") }),
  execute: async ({ city }) => {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
    return await res.json();
  },
});

export default agent({
  name: "Weather Assistant",
  systemPrompt: "You help callers plan around the weather. Keep replies short.",
  tools: { get_weather: getWeather },
  ...assemblyAIPipeline({ voice: "michael" }),
});
```

`aai dev` serves it with a built-in browser voice client; a custom UI is an
optional `client.tsx` built on
[`@alexkroman1/aai-ui`](./packages/aai-ui/README.md).

## Packages

| Package | What it is |
| --- | --- |
| [`@alexkroman1/aai`](./packages/aai/README.md) | The SDK: `agent()`, `tool()`, provider factories, the self-hostable runtime |
| [`@alexkroman1/aai-ui`](./packages/aai-ui/README.md) | Browser client: React components, hooks, and the framework-agnostic session core |
| [`@alexkroman1/aai-cli`](./packages/aai-cli/README.md) | The `aai` CLI: init, dev, test, build, deploy, secret, storage |

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
