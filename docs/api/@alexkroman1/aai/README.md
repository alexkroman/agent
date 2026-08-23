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

`agent()` takes one object. `AgentDef` is the reference for what each field
MEANS — every field and default is documented there — and `AgentParams` is the
reference for which combinations are LEGAL. A fuller configuration, with the
fields the two examples above leave out:

```ts
import { agent, sessionSlot } from "@alexkroman1/aai";

const cart = sessionSlot("cart", () => ({ items: [] as string[] }));

export default agent({
  name: "Storefront",
  systemPrompt: "You help callers order from the catalog. Confirm before charging.",
  greeting: "Storefront here — what are you after?",
  voice: "michael",
  // Server-side helpers the model may call, on top of your own tool files.
  builtinTools: ["calculate"],
  // Tool-calling steps per reply, and how long a pause ends the caller's turn.
  maxSteps: 6,
  minTurnSilenceMs: 1200,
  // What the browser client renders with `useAgentState`.
  syncState: cart.projection((c) => ({ count: c.items.length })),
  // Observe-only hooks over the session event stream.
  events: {
    "tool.called": (event) => {
      console.log("called", event.toolName);
    },
  },
});
```

## Session modes and providers

**Pipeline mode** (default) streams STT partials into a server-side LLM
loop and speaks the reply through a TTS provider. Swap any stage with a
factory from the provider subpaths — set any subset of `stt`, `llm`, `tts`;
the unset stages keep the AssemblyAI default:

| Subpath | Factories |
| --- | --- |
| `@alexkroman1/aai/stt` | `assemblyAIStt`, `deepgram`, `elevenLabsStt`, `soniox` |
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

## Testing an agent

A tool is a file, so `agent.ts`'s default export carries no tools —
`withDiscoveredTools` gives you the definition a deployed agent runs:

```ts no-check
// `no-check`: import.meta.glob needs your project's vite/client types.
import { createToolContext, runTool, withDiscoveredTools } from "@alexkroman1/aai/testing";
import { expect, test } from "vitest";
import authored from "./agent.ts";

const agentDef = withDiscoveredTools(authored, import.meta.glob("./tools/*.ts", { eager: true }));

test("saves a note", async () => {
  expect(await runTool(agentDef, "add_note", { text: "milk" }, createToolContext())).toEqual({
    saved: 1,
  });
});
```

`createToolContext()` builds a full `ToolContext` with inert defaults and a
recording `ctx.send`; `stubGenerate`, `stubGateway` and `stubUploads` drive
what a tool's collaborators answer.

## Other subpaths

Each subpath is named by WHO READS IT — reach for one when the right-hand
column describes what you are doing.

| Subpath | Reach for it when |
| --- | --- |
| `/testing`, `/testing/vitest` | testing your own tools — `createToolContext`, `withDiscoveredTools`, `runTool` |
| `/stt`, `/llm`, `/tts`, `/s2s` | picking a provider for a pipeline stage (the table above) |
| `/step`, `/step-errors` | writing a `"use step"` body inside a workflow — `stepFetch`, `stepEnv`, `mapConcurrent`, `stepGenerate` |
| `/workflow-api` | calling a deployed agent from a page, a script or a cron job — `createAgentClient` |
| `/tools` | calling `fetchJson`, `visitWebpage` or `webSearch` from your own tool code |
| `/utils` | small helpers written inside a tool body — `toolFailure`, `errorMessage`, `pushCapped`, `withLock` |
| `/ffmpeg` | running ffmpeg from a step — `runFfmpeg`, `probeMedia`, `transcodeToWav` |
| `/runtime` | self-hosting the Node runtime — `createRuntime()`, `createServer()` |
| `/protocol`, `/manifest`, `/slugify`, `/workspace-files`, `/internal` | framework internals used by the CLI and the platform; not a public API and not covered by semver |

## Documentation

Full API reference: <https://alexkroman.github.io/agent/>

## Modules

- [ffmpeg](ffmpeg.md)
- [index](index.md)
- [llm](llm.md)
- [manifest](manifest.md)
- [protocol](protocol.md)
- [s2s](s2s.md)
- [step](step.md)
- [step-errors](step-errors.md)
- [step-files](step-files.md)
- [stt](stt.md)
- [testing](testing.md)
- [testing/vitest](testing/vitest.md)
- [tools](tools.md)
- [tts](tts.md)
- [utils](utils.md)
- [workflow-api](workflow-api.md)
