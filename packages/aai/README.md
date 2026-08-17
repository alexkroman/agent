# @alexkroman1/aai

The aai voice-agent SDK: everything an `agent.ts` file imports, plus the
self-hostable runtime the CLI and the managed platform run.

```sh
npm i @alexkroman1/aai zod
```

Most projects don't install this directly — `aai init` (from
[`@alexkroman1/aai-cli`](https://www.npmjs.com/package/@alexkroman1/aai-cli))
scaffolds a project with it wired up.

## Defining an agent

`agent.ts` — the definition, plus the slot that owns this session's state:

```ts
import { agent, sessionSlot } from "@alexkroman1/aai";

export const notesSlot = sessionSlot("notes", () => ({ items: [] as string[] }));

export default agent({
  name: "Notes",
  systemPrompt: "You take short notes for the caller.",
  // Show the slot to the browser client, read there with `useAgentState`.
  syncState: notesSlot.projection((notes) => ({ count: notes.items.length })),
});
```

`tools/add_note.ts` — **a tool is a FILE**, named by its own filename, and
`agent()` takes no `tools` field. Nothing registers it:

```ts no-check
import { z } from "zod";
import { notesSlot } from "../agent.ts";

export default notesSlot.updateTool({
  description: "Save a note for the caller",
  inputSchema: z.object({ text: z.string() }),
  // `updateTool` hands the body a mutable draft, stored when it returns.
  execute: ({ text }, notes) => {
    notes.items.push(text);
    return { saved: notes.items.length };
  },
});
```

- `agent()` — the agent definition; every field and default is documented
  on [`AgentDef`](https://alexkroman.github.io/agent/). With no provider
  fields it runs the default all-AssemblyAI STT → LLM → TTS pipeline,
  billed to one `ASSEMBLYAI_API_KEY`; `voice: "michael"` picks its TTS
  voice.
- `tool()` — a typed tool for the stateless case: Zod `inputSchema` and an
  `execute(args, ctx)` that runs server-side with `ctx.env`, `ctx.db`
  (opt-in SQL storage), `ctx.generate` (one-shot LLM calls), `ctx.workflows`
  (start and watch durable runs), and `ctx.send` (push events to the
  browser client).
- `sessionSlot()` — a typed named slot owning a session's state. `slot.tool()`
  reads it (the value is deeply frozen), `slot.updateTool()` writes it
  synchronously, and it persists through the app database when one is
  enabled. There is no `ctx.state`.
- `assemblyAIPipeline()` — the same default pipeline as an explicit spread
  (`...assemblyAIPipeline({ region: "eu" })`), for when you want the three
  stages visible in the config or an EU region across STT and the gateway.

## Session modes and providers

**Pipeline mode** (default) streams STT partials into a server-side LLM
loop and speaks the reply through a TTS provider. Swap any stage with a
factory from the provider subpaths — set any subset of `stt`, `llm`, `tts`;
the unset stages keep the AssemblyAI default:

| Subpath | Factories |
| --- | --- |
| `@alexkroman1/aai/stt` | `assemblyAIStt`, `deepgram`, `elevenlabs`, `soniox` |
| `@alexkroman1/aai/llm` | `assemblyAILlm`, `anthropic`, `openai`, `google`, `mistral`, `xai`, `groq`, `openrouter`, `gateway` |
| `@alexkroman1/aai/tts` | `assemblyAITts`, `cartesia`, `rime` |

Factories return pure descriptors — serializable data, not SDK clients.
Credentials are resolved server-side from the agent's env (each factory's
docs name the env var), so no provider SDK or secret ever enters the agent
bundle. `llm` also accepts a model-id string: `"creator/model"` routes
through the Vercel AI Gateway, a bare id through the AssemblyAI LLM
Gateway — `agent({ name: "...", llm: "claude-sonnet-4-6" })` swaps just the
model.

**S2S mode** is the explicit opt-in to a speech-to-speech service, where
STT, the LLM loop, and TTS all run service-side over one socket:
`s2s: assemblyAIS2s()` (root export) or `openaiRealtime()` from
`@alexkroman1/aai/s2s`.

## Other subpaths

- `@alexkroman1/aai/runtime` — the full Node runtime for self-hosting:
  `createRuntime()`, `createServer()`.
- `@alexkroman1/aai/tools` — keyless network helpers callable from tool
  code: `fetchJson`, `visitWebpage`, `webSearch`.
- `@alexkroman1/aai/utils` — zod-free utilities (fast import path).
- `@alexkroman1/aai/protocol`, `@alexkroman1/aai/manifest` — wire schemas
  and config extraction, used by the CLI/server.
- `@alexkroman1/aai/internal` — infrastructure shared with the sibling
  packages; not a public API and not covered by semver.

## Documentation

Full API reference: <https://alexkroman.github.io/agent/>
