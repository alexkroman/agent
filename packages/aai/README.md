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

```ts
import { agent, assemblyAIPipeline, tool } from "@alexkroman1/aai";
import { z } from "zod";

const addNote = tool({
  description: "Save a note for the caller",
  inputSchema: z.object({ text: z.string() }),
  execute: ({ text }, ctx) => {
    ctx.state.notes.push(text);
    return { saved: ctx.state.notes.length };
  },
});

export default agent({
  name: "Notes",
  systemPrompt: "You take short notes for the caller.",
  state: () => ({ notes: [] as string[] }),
  tools: { add_note: addNote },
  ...assemblyAIPipeline(),
});
```

- `agent()` — the agent definition; every field and default is documented
  on [`AgentDef`](https://alexkroman.github.io/agent/).
- `tool()` — a typed tool: Zod `inputSchema`, an `execute(args, ctx)` that
  runs server-side with access to `ctx.state`, `ctx.env`, `ctx.db` (opt-in
  SQL storage), `ctx.generate` (one-shot LLM calls), and `ctx.send`
  (push events to the browser client).
- `assemblyAIPipeline()` — the default STT → LLM → TTS pipeline, all billed
  to one `ASSEMBLYAI_API_KEY`. It is also what an `agent()` with no
  provider fields runs on.

## Session modes and providers

**Pipeline mode** (default) streams STT partials into a server-side LLM
loop and speaks the reply through a TTS provider. Swap any stage with a
factory from the provider subpaths — set all three of `stt`, `llm`, `tts`
(or spread the preset and override one):

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
Gateway — `agent({ ...assemblyAIPipeline(), llm: "claude-sonnet-4-6" })`
swaps just the model.

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
