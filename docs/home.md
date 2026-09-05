# AAI SDK

Voice agent development kit. Define a voice agent as a TypeScript file,
run it locally with a browser voice client, and deploy it with one command.

```sh
npm i -g @alexkroman1/aai-cli
aai init my-agent
cd my-agent
aai dev
```

`agent.ts` — the definition:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Weather Assistant",
  systemPrompt: "You help callers plan around the weather. Keep replies short.",
  voice: "michael",
});
```

`tools/get_weather.ts` — **a tool is a FILE**, named by its own filename and
registered by nothing. `agent()` takes no `tools` field:

```ts
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Get current weather for a city",
  inputSchema: z.object({ city: z.string().describe("City name") }),
  execute: async ({ city }) => {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
    return await res.json();
  },
});
```

With no provider fields the agent runs an all-AssemblyAI STT → LLM → TTS
pipeline billed to one `ASSEMBLYAI_API_KEY`; `voice` picks its TTS voice.
Set any of `stt`, `llm`, `tts` to swap a single stage — e.g.
`llm: "claude-sonnet-4-6"` — and the unset stages keep the default.

## What's documented here

This is the API reference for the two published SDK packages:

- **`@alexkroman1/aai`** — the SDK an `agent.ts` imports. Start with
  `agent()` and `tool()` on the root module, then the provider factory
  subpaths (`stt`, `llm`, `tts`, `s2s`) to swap pipeline stages, `tools`
  for the keyless network helpers callable from tool code, and `runtime`
  for self-hosting.
- **`@alexkroman1/aai-ui`** — the browser client for custom UIs:
  `mountClient()`, the session hooks (`useSession`, `useAgentState`,
  `useToolResult`, `useEvent`), and the framework-agnostic
  `createBrowserSession()`.

The `aai` CLI (`@alexkroman1/aai-cli`) is documented in its
[README](https://github.com/alexkroman/agent/tree/main/packages/aai-cli#readme)
— its importable subpaths are internal build hooks, not a public API.

## More

- [GitHub repository](https://github.com/alexkroman/agent)
- [Agent-building guide](https://github.com/alexkroman/agent/blob/main/packages/aai-templates/scaffold/CLAUDE.md)
  (ships into every scaffolded project as `CLAUDE.md`)
