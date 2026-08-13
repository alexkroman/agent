<!--
  GENERATED FILE — do not edit.

  Source: packages/aai-templates/scaffold/CLAUDE.md
  Regenerate: node scripts/sync-agent-guide.mjs

  This copy ships inside the @alexkroman1/aai tarball so an agent working in
  a user's project can read guidance that MATCHES the installed SDK, rather
  than the copy `aai init` froze into the project at scaffold time. See
  packages/aai/skills/aai/SKILL.md.
-->
# aai Voice Agent

You are helping build a voice agent using the **aai** framework.

## Workflow

The fast loop: edit → `pnpm dev` (browser, talk to it) →
`pnpm test` (logic) → `pnpm build` (validate bundle).

1. **Iterate in `pnpm dev`** — hot reload + browser UI. Speak to the
   agent to verify behavior end-to-end. This is the primary feedback loop.
2. **Run `pnpm test` after logic changes** — vitest. Co-locate tests as
   `agent.test.ts` (see `pipeline-simple` template for a reference).
   **When the project has an `agent.test.ts` (the default `simple`
   template and several others ship one), it is yours to maintain.** It
   asserts the agent's shape — name, providers, tool names —
   so rewriting the agent without updating it leaves a test asserting an
   agent that no longer exists. When a test fails after your change, decide
   which side is stale: updating the test to match the new agent is a normal
   fix, not a workaround. Do not delete a test to make it pass.
3. **Run `pnpm build` before declaring done** — bundles `agent.ts`,
   type-checks, and validates the manifest. Catches issues `dev` won't.
4. **Make small, focused changes** — verify each one before stacking the
   next.
5. **Look at templates before writing custom code** — the CLI ships working
   examples inside its own package, at
   `node_modules/@alexkroman1/aai-cli/dist/templates/`. Read them directly;
   `aai init --template <name>` scaffolds a fresh project from one. Closest
   matches: `simple`, `pipeline-simple`, `web-researcher`, `solo-rpg`,
   `pizza-ordering`, `retail` (the most complex — 15 tools over a
   relational store, with a `syncState`-driven UI). When reading SDK
   types under
   `node_modules/@alexkroman1/aai*/dist/`, note the built entry points
   re-export with source specifiers (`"./sdk/constants.ts"`,
   `"./components/button.tsx"`) — rewrite `.ts`/`.tsx` to `.d.ts` to find
   the shipped file.

## CLI

```sh
npx @alexkroman1/aai-cli init             # Scaffold a new agent
npx @alexkroman1/aai-cli templates        # List available templates
npx @alexkroman1/aai-cli dev              # Start local dev server
npx @alexkroman1/aai-cli test             # Run agent.test.ts via vitest
npx @alexkroman1/aai-cli build            # Bundle and validate
npx @alexkroman1/aai-cli deploy           # Deploy to production
npx @alexkroman1/aai-cli delete           # Remove deployed agent
npx @alexkroman1/aai-cli secret put NAME  # Set a secret
npx @alexkroman1/aai-cli secret delete NAME
npx @alexkroman1/aai-cli secret list
```

The scaffold's `package.json` exposes `dev`, `build`, `test`, and `deploy`
as `pnpm <name>` shortcuts. Other commands (`init`, `templates`, `delete`, `secret`)
are CLI-only.

## Running it yourself (`npm start`)

`server.mjs` serves this agent from a plain Node process — no CLI, no
bundler, no platform account. It is the deployment counterpart of `aai dev`:

```sh
npm start                          # http://127.0.0.1:3000
PORT=8080 HOST=0.0.0.0 npm start   # bind every interface, e.g. in a container
```

Secrets work the same as everywhere else: `ctx.env` holds the keys declared
in `.env` (or `.env.example`), and a real environment variable of that name
wins — so `docker run -e MY_API_KEY=…` needs no `.env` in the image.

Two things to know. It binds **loopback by default**, because this server has
no request authentication of its own; set `HOST=0.0.0.0` only behind your own
proxy or auth. And with a custom `client.tsx`, run `npm run build` first —
otherwise it serves the default UI and says so at startup.

Deleting `server.mjs` costs nothing: `aai dev`, `aai publish` and the managed
platform never read it. `run_code` is the one feature that does not follow —
it needs the platform's sandbox and refuses outside one.

## Project structure

```text
my-agent/
  agent.ts            # Agent definition (required)
  agent.test.ts       # Unit tests (optional)
  client.tsx          # Custom UI (optional, React)
  shared.ts           # Types shared between agent.ts and client.tsx
  system-prompt.md    # Long system prompts (optional, imported)
  tools/              # Tool files when too large for inline (optional)
  workflows/          # Durable workflow bodies (optional — see "Workflow apps")
  package.json
  tsconfig.json
  .env                # Local dev secrets (gitignored)
```

## `agent()` API

```ts no-check
import { agent } from "@alexkroman1/aai";

export default agent({
  name: string;                              // required — display name
  systemPrompt?: string;                     // default: general voice assistant
                                             // (`system` is an accepted alias)
  greeting?: string;                         // default: "Hey there..."
  voice?: string;                            // TTS voice for the default pipeline, e.g. "michael"
                                             // (shorthand for tts: assemblyAITts({ voice });
                                             // invalid with an explicit `tts` or with `s2s`)
  stt?: SttProvider;                         // pipeline stage overrides — set any subset;
  llm?: LlmProvider | string;                // unset stages default to AssemblyAI
  tts?: TtsProvider;                         // (llm also takes a model-id string)
  s2s?: S2sProvider;                         // explicit opt-in to speech-to-speech mode
  sttPrompt?: string;                        // STT guidance for jargon/acronyms
  builtinTools?: BuiltinTool[];              // see built-in tools table
  tools?: Record<string, ToolDef>;
  maxSteps?: number;                         // default: 10 — max tool calls per turn
  toolChoice?: ToolChoice;                   // "auto" (default) | "required" | "none"
                                             // | { type: "tool", toolName }
  idleTimeoutMs?: number;                    // disconnect after inactivity (ms)
  silenceTimeoutMs?: number;                 // pipeline only — assistant speaks up after this much user silence (ms)
  silencePrompt?: string;                    // instruction injected on silence timeout (requires silenceTimeoutMs)
  minBargeInWords?: number;                  // pipeline only — words before user speech interrupts the reply (default 2)
  interruptionMinDurationMs?: number;        // pipeline only — sustained speech (ms) before an interim barge-in interrupts (default 500; 0 disables)
  deadAirCoverMs?: number;                   // pipeline only — speak a short filler after this much silence in a turn (default 5000; 0 disables)
  resumeFalseInterruption?: boolean;         // pipeline only — resume an interrupted reply if no user turn commits (default true)
  preemptiveGeneration?: boolean;            // pipeline only — start the reply from a high-confidence interim (default true; false opts out)
  state?: () => S;                           // per-session mutable state, exposed as ctx.state
                                             // (S is inferred; see "Typing ctx.state")
  syncState?: (state: S) => unknown;         // push a projection of state to the client
                                             // (read it with useAgentState; see UI hooks)
});
```

> Unless `s2s` is set, the agent runs in **Pipeline mode** — see the section
> below. Declare any subset of `stt`/`llm`/`tts`; unset stages default to
> AssemblyAI. `llm` also accepts a model-id string: `"creator/model"` routes
> through the Vercel AI Gateway (`AI_GATEWAY_API_KEY`), a bare id through
> the AssemblyAI LLM Gateway (`ASSEMBLYAI_API_KEY`).

Minimal agent — a cascaded pipeline, which is what you should build unless
the user asks for the speech-to-speech API:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
});
```

No provider fields means the default all-AssemblyAI pipeline: all three
stages bill to the one key a published agent is guaranteed to have. Pick
its voice with the `voice` field — this is the normal way to choose a
voice:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
  voice: "paul",
});
```

Swap a single stage by declaring just that field — everything you leave
unset stays on the default. `llm` accepts the gateway model id as a plain
string:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
  llm: "claude-sonnet-4-6",
});
```

`assemblyAIPipeline()` (from `@alexkroman1/aai`) is the explicit spelling of
the same default — spread it (`...assemblyAIPipeline({ region: "eu" })`) when
you want the three stages visible in the config or EU data residency across
STT and the LLM gateway. Speech-to-speech (S2S) mode is an explicit opt-in
via the `s2s` field — see below.

System prompt from file:

```ts
/// <reference types="vite/client" />
import { agent } from "@alexkroman1/aai";
import systemPrompt from "./system-prompt.md?raw";
export default agent({ name: "My Agent", systemPrompt });
```

**JSON imports need no attribute.** `resolveJsonModule` is on, so
`import data from "./knowledge.json"` is all it takes. Do NOT write
`assert { type: "json" }` — import assertions were replaced by import
attributes and TypeScript rejects them (`TS2880`). If you want to be
explicit the modern spelling is `with { type: "json" }`, but plain is fine.

## Workflow apps — `workflowApp()`

Not every agent's front door is a microphone. When the product is a FORM —
submit a job, watch it run, read the result — declare it with `workflowApp()`
instead of `agent()`:

```ts no-check
import { workflow, workflowApp } from "@alexkroman1/aai";
import { z } from "zod";
import { digestFlow } from "./workflows/digest.ts";

export const digest = workflow({
  description: "Summarize a link and file the digest",
  input: z.object({ url: z.url().describe("The link to digest") }),
  run: digestFlow,
});

export default workflowApp({
  name: "Link Digest",
  workflows: { digest },
});
```

That is the whole declaration, and the fields it does NOT take are the point:
a workflow app has no session and no LLM loop, so `systemPrompt`, `tools`,
`maxSteps`, `state`, `syncState`, `stt`/`llm`/`tts`/`s2s` and every voice knob
are **compile errors** here, not fields that quietly do nothing. `greeting` and
`requiredEnv` stay. `workflowApp()` is `agent({ …, page: "static" })` with the
discriminant already set — same definition object out, so `aai build`,
`aai dev` and `aai publish` treat it like any other agent.

Reach for it when the user asks for something that outlives a request: an
overnight job, an upload that takes minutes, anything waiting on a third-party
callback. Reach for `agent()` when someone is on the line — a voice agent can
also START a workflow from a tool (`ctx.workflows.start(def, input)`) and
answer the turn, which is the other shape.

**Requires storage** (`aai storage enable`, or `DATABASE_URL` under
`aai dev`): runs live in the database.

### Workflow bodies live in `workflows/`

The build transforms that directory and nothing else. A `"use workflow"` body
written in `agent.ts` is never transformed — it runs inline once, with no
durability and nothing saying so.

```ts
import { sleep } from "workflow";

export async function digestFlow(input: { url: string }) {
  "use workflow";

  const digest = await summarize(input.url);
  // Suspended, not blocked: the container is free to exit here and the run
  // resumes when it comes due. `"6 hours"` works the same as `"10 seconds"`.
  await sleep("10 seconds");
  return { ...digest, filedAt: await file(digest) };
}

async function summarize(url: string) {
  "use step";
  // The whole Node runtime is available in a step: fetch, a model call, a
  // database. Not in the body.
  return { url, headline: `What ${new URL(url).hostname} says`, points: [] };
}

async function file(digest: { url: string }) {
  "use step";
  return new Date().toISOString();
}
```

Three rules, all of which fail silently if broken:

- **The body replays from the top on every resume**, so it holds no live handle
  and makes no undurable decision — no `Date.now()`, no `Math.random()`, no
  `fetch`. Those belong in a step, whose result is journaled and returned
  unchanged on replay.
- **A step's arguments and return value cross a queue**, so they must be
  JSON-shaped and small. Put bytes in storage and pass the key.
- **A step gets no tool context** — no `ctx.env`, no `ctx.db`. It is bundled
  and dispatched separately from the agent.

### The page

A workflow app's `client.tsx` mounts with `page()` rather than `client()` —
there is no session to build, so no socket, no audio graph and no microphone
request. Everything else is the same file, React and Tailwind included.

```tsx no-check
import { createWorkflowApi, page, useWorkflowRun } from "@alexkroman1/aai-ui";
import "@alexkroman1/aai-ui/styles.css";
import type { WorkflowOutputOf } from "@alexkroman1/aai";
import { useState } from "react";
import type { digest } from "./agent.ts";

// Hoisted: a client built in render is a new object every render.
const api = createWorkflowApi();

export function App() {
  const [runId, setRunId] = useState<string>();
  // The generic is what makes `run.output` typed rather than `unknown`.
  const { run, polling } = useWorkflowRun<WorkflowOutputOf<typeof digest>>(runId, { api });

  return (
    <main>
      <button
        type="button"
        onClick={async () => setRunId(await api.start("digest", { url: "https://example.com" }))}
      >
        Digest
      </button>
      {polling && <p>Working. You can close this tab — the run continues.</p>}
      {run?.status === "completed" && <h2>{run.output.headline}</h2>}
    </main>
  );
}

page({ name: "Link Digest", component: App });
```

`api.start()` resolves as soon as the RUN EXISTS, not when it finishes — that
is the whole mechanism. The `runId` is the entire client state, so it survives
a reload, a different device, or `curl`. Note the workflow is named by the key
it has in `workflows` above (`"digest"`); nothing else records that string, so
a rename there is a 400 here rather than a compile error.

The same routes are scriptable, which is the other half of having an API:

```text
GET    /workflows                 → the declared workflows, with input schemas
POST   /workflows/runs            → { runId }   body: { workflow, input?, key?, wait? }
GET    /workflows/runs/:id        → a run snapshot
DELETE /workflows/runs/:id        → cancel
GET    /workflows/runs/:id/events → SSE
```

## Pipeline mode

Pipeline mode is the default: omitting `stt`/`llm`/`tts` (and `s2s`) gives
you the all-AssemblyAI pipeline, and any stage you do declare replaces just
that stage — the rest keep the default.

**S2S mode is an explicit opt-in.** Setting `s2s: assemblyAIS2s()` (imported
from `@alexkroman1/aai`, next to `agent()`) selects AssemblyAI's
speech-to-speech Voice Agent API: STT, the LLM loop, and TTS run
service-side in one socket. Fewer moving parts, but you cannot choose the
model or swap a provider. There is no way to reach S2S by omission — only
the `s2s` field selects it, and it is mutually exclusive with the
`stt`/`llm`/`tts` triple.

```ts
import { agent, assemblyAIS2s } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
  s2s: assemblyAIS2s(),
});
```

The descriptor takes three optional knobs, all forwarded only when set:

```ts
import { agent, assemblyAIS2s } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
  sttPrompt: "Callers spell order numbers one character at a time.",
  s2s: assemblyAIS2s({
    voice: "michael",
    languages: ["en"],
    keyterms: ["Acme Rewards", "SKU"],
  }),
});
```

- `voice` — the agent's voice. Unset uses the service default.
- `languages` — **leave it unset for multilingual calls**: unset means
  "detect per turn", so pinning `["en"]` on a line that takes other
  languages disables detection for every caller. Pin it when the line
  really is monolingual — on a benchmark run that plus a transcription
  prompt took a caller's spelled first name from 1 of 6 attempts correct
  to 6 of 6.
- `keyterms` — product names and proper nouns to bias transcription
  toward. Use `sttPrompt` (above, and honoured in **both** modes) for
  prose guidance and `keyterms` for a term list.

**Prefer pipeline mode** — the default — unless the user specifically
asks for the speech-to-speech API. Nearly every template ships this way, and
it is what AssemblyAI Build defaults to. The host runs the LLM loop locally
(Vercel AI SDK) with your chosen STT, LLM, and TTS. You want explicit
providers when:

- you want a specific LLM (Anthropic, OpenAI, Gemini, Mistral, xAI, Groq,
  hundreds of models via OpenRouter, or 25+ models via the AssemblyAI
  LLM Gateway)
- you want a specific STT model, or a non-AssemblyAI TTS provider (for the
  default pipeline's voice, use the `voice` field instead)
- you need to swap providers without changing agent code

**The rule:** declare only the stages you're changing — any subset of
`stt`, `llm`, `tts`; each unset stage runs on the AssemblyAI default.
Combining `s2s` with any pipeline provider or pipeline-only tuning field is
a compile error naming the rule, as is `voice` alongside an explicit `tts`
descriptor (the descriptor owns its own voice). A raw config that skips
`agent()` is still checked at parse time.

```ts
import { agent } from "@alexkroman1/aai";
import { assemblyAIStt } from "@alexkroman1/aai/stt";
import { anthropic } from "@alexkroman1/aai/llm";
import { cartesia } from "@alexkroman1/aai/tts";

export default agent({
  name: "My Agent",
  stt: assemblyAIStt({ model: "universal-3-5-pro" }),
  llm: anthropic({ model: "claude-haiku-4-5" }),
  tts: cartesia(),
});
```

Tools, the database, `ctx`, and the UI all behave identically across modes.
Only the audio + LLM transport differs.

**There is no text-only agent mode.** An agent is a voice conversation —
every pipeline agent must declare a real TTS provider.

**Silence nudge (pipeline only):** set `silenceTimeoutMs` to make the
assistant proactively take a turn after that much user silence (e.g.
"Are you still there?"). Customize the injected instruction with
`silencePrompt`. The nudge never appears as a user transcript, and the
assistant stops nudging after 3 consecutive unanswered nudges until the
user speaks again.

**Voice-UX tuning (pipeline only):** `minBargeInWords` controls how many
words of user speech interrupt the assistant mid-reply (default 2, so
one-word backchannels like "yeah" don't cut it off);
`interruptionMinDurationMs` adds a sustained-speech gate on top (default
500 ms; `0` disables; interim transcripts only — committed turns always
land). End-of-turn detection (how long a pause ends the user's turn)
belongs to the STT provider: `assemblyAIStt({ minTurnSilenceMs })` (default
2000 ms) / `deepgram({ endpointing })` (default 1500 ms), so mid-utterance
pauses don't split a request.
`deadAirCoverMs` is how long a turn may go silent before the transport speaks
a short filler, so a long tool chain doesn't sound like a dropped call. It is
measured silence, not a guess about the turn's shape, so a reply that arrives
promptly pays nothing; `0` disables it. The wording is not yours to set — the
filler must be purely declarative and never a request for patience, or the
caller answers it and the answer barges in.
`resumeFalseInterruption` (default `true`) resumes an interrupted reply when
a barge-in turns out to be noise — no user turn ever commits. The wait is not
configurable: the resume fires once the transcript stream goes quiet with no
final, so it can never race a real turn the STT is still endpointing.
`preemptiveGeneration` (default `true`) starts generating the reply as soon
as transcription is confident the caller has finished, and uses that
already-running answer if the committed transcript matches. It can shorten the
pause before the agent speaks, and **how much is unmeasured** — nobody has
shown the size of the saving. What bounds the downside is that a speculation
never speaks, calls a tool, or enters history until the real turn adopts it, so
the worst case is a wasted request and a turn that behaves exactly as it would
with the flag off. Set `preemptiveGeneration: false` to opt out — worth doing
on a tool-heavy agent, where a speculation that reaches a tool call is thrown
away, so it is cost with no upside.

## Providers

Provider SDKs are **optional peer dependencies**. Install only the SDKs
for the providers you actually use.

### STT — `@alexkroman1/aai/stt`

| Factory         | Default model          | Env var              |
| --------------- | ---------------------- | -------------------- |
| `assemblyAIStt` | `"universal-3-5-pro"`  | `ASSEMBLYAI_API_KEY` |
| `deepgram`      | `"nova-3"`             | `DEEPGRAM_API_KEY`   |
| `elevenlabs`    | `"scribe_v2_realtime"` | `ELEVENLABS_API_KEY` |
| `soniox`        | `"stt-rt-v3"`          | `SONIOX_API_KEY`     |

All STT factories accept `{ model?: string, ... }`. Bare calls
(`deepgram()`, `soniox()`, etc.) use the default model.

`assemblyAIStt` accepts an optional `region: "eu"` for EU data residency —
it routes streaming transcription to AssemblyAI's EU endpoints. EU-region
API keys require it; the US endpoints reject them. Example:
`assemblyAIStt({ model: "universal-3-5-pro", region: "eu" })`.

### LLM — `@alexkroman1/aai/llm`

| Factory         | SDK package         | Env var                        |
| --------------- | ------------------- | ------------------------------ |
| `anthropic`     | `@ai-sdk/anthropic` | `ANTHROPIC_API_KEY`            |
| `openai`        | `@ai-sdk/openai`    | `OPENAI_API_KEY`               |
| `google`        | `@ai-sdk/google`    | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `mistral`       | `@ai-sdk/mistral`   | `MISTRAL_API_KEY`              |
| `xai`           | `@ai-sdk/xai`       | `XAI_API_KEY`                  |
| `groq`          | `@ai-sdk/groq`      | `GROQ_API_KEY`                 |
| `openrouter`    | `@ai-sdk/openai`    | `OPENROUTER_API_KEY`           |
| `gateway`       | `ai` (built in)     | `AI_GATEWAY_API_KEY`           |
| `assemblyAILlm` | `@ai-sdk/openai`    | `ASSEMBLYAI_API_KEY`           |

LLM factories require `{ model: string }`. Example:
`anthropic({ model: "claude-haiku-4-5" })`.

`openrouter` routes through [OpenRouter](https://openrouter.ai) — an
OpenAI-compatible endpoint fronting hundreds of models addressed as
`"creator/model"`, e.g.
`openrouter({ model: "meta-llama/llama-3.3-70b-instruct" })`. It needs
no extra SDK install (it reuses the `@ai-sdk/openai` client).

`gateway` routes through the [Vercel AI
Gateway](https://vercel.com/docs/ai-gateway) — one endpoint fronting
hundreds of models addressed as `"creator/model"`, e.g.
`gateway({ model: "zai/glm-4.6" })`. It needs no extra SDK install
(the gateway client ships inside the `ai` package).

`assemblyAILlm` routes through the [AssemblyAI LLM
Gateway](https://www.assemblyai.com/docs/llm-gateway) — an
OpenAI-compatible endpoint fronting 25+ models (Claude, GPT, Gemini,
etc.) with the same API key as AssemblyAI STT. A bare model-id string on
`llm` is shorthand for it, and unset stages keep the AssemblyAI default:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
  llm: "claude-sonnet-4-6",
});
```

`assemblyAILlm({ model, region: "eu" })` is the explicit form; `region`
selects EU data residency.

Mixing providers works the same way — declare the stages you're changing:

```ts
import { agent } from "@alexkroman1/aai";
import { cartesia } from "@alexkroman1/aai/tts";

export default agent({
  name: "My Agent",
  llm: "claude-sonnet-4-6",
  tts: cartesia(),
});
```

### TTS — `@alexkroman1/aai/tts`

| Factory         | Default voice                            | Env var              |
| --------------- | ---------------------------------------- | -------------------- |
| `assemblyAITts` | `"jane"`                                 | `ASSEMBLYAI_API_KEY` |
| `cartesia`      | `"f786b574-daa5-4673-aa0c-cbe3e8534c02"` | `CARTESIA_API_KEY`   |
| `rime`          | `"cove"` (model `mistv2`)                | `RIME_API_KEY`       |

Bare calls (`assemblyAITts()`, `cartesia()`, `rime()`) use the defaults.
Override with `{ voice, model, language }`.

**AssemblyAI TTS** shares `ASSEMBLYAI_API_KEY` with AssemblyAI STT and the
LLM Gateway, so an all-AssemblyAI pipeline needs exactly one secret. On the
default pipeline, `agent({ voice: "michael" })` is the shorthand for
`tts: assemblyAITts({ voice: "michael" })` — same catalog, same rules. Each
voice speaks one language, and this is the whole catalog — **a voice not on
this list is rejected after the socket opens, which leaves the agent
connected, "ready", and permanently silent**, so pick one from here rather
than guessing a plausible name:

- **English, US accent**: `alba`, `anna`, `charles`, `eve`, `george`,
  `jane` (the default), `jean`, `mary`, `michael`
- **English, UK accent**: `paul`, `vera`
- **Native accent, code-switches with English**: `estelle` (fr),
  `giovanni` (it), `juergen` (de), `lola` (es), `rafael` (pt)

There is no separate age/gender/style axis — match the persona by picking a
name and accent, and put the delivery in the system prompt instead.

Set
`language` only alongside a voice that speaks it, as an ISO 639-1 code —
`"en"`, `"fr"`, `"de"`, `"it"`, `"pt"`, `"es"` are the six the catalog
covers, and the SDK translates each to the full name the service wants.
Anything else fails at session start.

**Rime quirk:** language uses ISO 639-3 three-letter codes (e.g. `"eng"`
not `"en"`).

Set provider keys the same way as any secret: `.env` for local dev,
`aai secret put` for production.

## `tool()` API

```ts no-check
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

const myTool = tool({
  description: string;           // shown to LLM — decides when to call
  inputSchema?: z.ZodObject;     // Zod schema (omit for no-arg tools)
  execute(args, ctx): unknown;   // sync or async
});
```

`execute` may call `fetch` directly — tool code reaches external APIs the
same way in `aai dev` and deployed.

### `ctx` (ToolContext)

```ts no-check
ctx.env: Readonly<Record<string, string>>     // secrets from .env / aai secret put
ctx.state: S                                   // per-session mutable state (agent's `state` factory)
ctx.db: Db                                     // SQL database, needs storage enabled (see Database section)
ctx.messages: readonly Message[]               // conversation history [{role, content}]
ctx.sessionId: string                          // unique session ID
ctx.send(event: string, data: unknown): void   // push custom event to browser client (silently dropped over 64 KB JSON)
ctx.generate(opts): Promise<{ text, object? }> // one-shot LLM call (host-side)
                                               // with a `schema`, `object` is REQUIRED and typed by it
ctx.signal: AbortSignal                        // aborts on barge-in, reset, session stop, or this call's timeout
```

**Pass `ctx.signal` to anything slow.** It is always present — no `?.`
needed — and forwarding it is what makes a tool stop work the caller has
already interrupted:

```ts
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export const lookup = tool({
  description: "Look up an order",
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }, ctx) => {
    const res = await fetch(`https://api.example.com/orders/${id}`, {
      signal: ctx.signal,
    });
    return await res.json();
  },
});
```

**Typing `ctx.state` is optional.** `ctx.state` is untyped by default, and
the project's tsconfig turns off `noImplicitAny`, so both of these compile
with no annotations and no errors:

```ts no-check
ctx.state.count++;
ctx.state.incidents.filter((i) => i.status === "open");
```

Write the code first. Do NOT add type annotations defensively — almost
nothing requires them, and time spent on them is time not spent on the agent.

**The one exception, and it is not optional: annotate any variable you
declare empty.** With `noImplicitAny` off, TypeScript does not widen an empty
initializer from what you later assign, so `[]` stays `never[]` and `null`
stays `null` — forever, whether or not a callback is involved:

```ts no-check
const items = [];            // never[]  → items.push(x) is an error
let best = null;             // null     → best = {...} is an error
const [picks, set] = useState([]);  // never[] in a client, same thing

const items: Pick[] = [];    // ✅ annotate the DECLARATION
let best: Pick | null = null;       // ✅
const [picks, set] = useState<Pick[]>([]);  // ✅
```

Annotating the *use* instead does not help — the declaration is still wrong,
so the next push reports the next line, and you can burn a whole session
fixing one call site at a time. This is the single most common way a
generated agent fails to build.

Declaring a state type is still worth it once the shape is settled, because
it turns a misspelled field into a compile error instead of `undefined` at
runtime:

```ts
import { agent, tool } from "@alexkroman1/aai";
import type { ToolContext } from "@alexkroman1/aai"; // types need `import type`
import { z } from "zod";

type Incident = { id: string; status: "open" | "closed" };
type State = { incidents: Incident[] };

const listOpen = tool({
  description: "List open incidents",
  execute: (_args, ctx: ToolContext<State>) => {
    // `i` infers as Incident, and `i.staus` would now be an error.
    return ctx.state.incidents.filter((i) => i.status === "open");
  },
});

export default agent({
  name: "Dispatch",
  state: (): State => ({ incidents: [] }),
  tools: { listOpen },
});
```

A tool annotated with a state shape the agent's factory doesn't produce is a
compile error, which is the point.

**`verbatimModuleSyntax` applies to every type you import** — `ToolContext`,
`ToolDef`, `Message`, provider types. A plain
`import { ToolContext }` fails; use `import type { ToolContext }`, or
`import { agent, type ToolContext }` to combine with value imports.

`ctx.generate({ prompt, system?, llm?, schema?, temperature?, maxOutputTokens? })`
runs one LLM generation on the host. It defaults to the agent's pipeline
`llm`; pass an `llm` descriptor (from `@alexkroman1/aai/llm`) or a model-id
string to use another provider whose API key is in the agent's secrets —
that's also how S2S agents use it. Pass a Zod schema as `schema` for typed
structured output (`generateObject`-style): the result's `object` carries
the parsed, typed value. A plain JSON Schema object also works.

### Inline tool example

```ts
import { agent, tool } from "@alexkroman1/aai";
import { z } from "zod";

export default agent({
  name: "Weather Agent",
  tools: {
    get_weather: tool({
      description: "Get current weather for a city",
      inputSchema: z.object({
        city: z.string().describe("City name"),
      }),
      async execute({ city }, ctx) {
        const resp = await fetch(
          `https://api.example.com/weather?q=${city}&key=${ctx.env.WEATHER_KEY}`,
        );
        return resp.json();
      },
    }),
  },
});
```

**Calling the network builtins from your own tool code.** `web_search`,
`visit_webpage` and `fetch_json` are declared to the MODEL — the LLM calls
them, and they are not on `ctx`. When your own `execute` needs one, import
it:

```ts no-check
import { fetchJson, visitWebpage, webSearch } from "@alexkroman1/aai/tools";

execute: async ({ city }) => await fetchJson(`https://api.example.com/${city}`),
// Reading fields off the result needs no cast. Pass a shape when you want
// it checked: `await fetchJson<Forecast>(url)`.
```

Same implementations the builtins use, so you get URL screening, credential-
header stripping, size caps and timeouts rather than a bare `fetch`. Plain
`fetch` still works when you want none of that. There is no callable
`run_code`: it exists to run code the model wrote, and tool code that wants
to compute something can just compute it.

**But prefer the BUILTIN when the model should decide.** These two are not
interchangeable:

- If the agent's job is to search or browse — a research assistant, anything
  that follows a link the user mentions — declare
  `builtinTools: ["web_search", "visit_webpage"]` and let the model call
  them. It can then search several times with different queries, or read one
  specific page, as the conversation needs.
- Import from `/tools` when YOUR tool's own logic needs a fetch: a currency
  tool hitting one known API, a price checker with a fixed endpoint.

Wrapping `webSearch` in a single custom tool is the mistake to avoid — it
replaces "the model searches as needed" with one fixed query-and-summarize
pipeline, and no amount of prompting gets the flexibility back.

**`inputSchema` is a Zod object, or absent.** The field itself is
optional, but its VALUE must be a plain `z.object(...)` — so all of these
are type errors:

```ts no-check
inputSchema: z.undefined(),                // ✗ ZodUndefined
inputSchema: z.void(),                     // ✗
inputSchema: z.object({ q: z.string() }).optional(),  // ✗ ZodOptional
```

For a tool with no arguments write `tool({ description, execute })`, or
`inputSchema: z.object({})` if you prefer it explicit. To make an individual
argument optional, put `.optional()` on the FIELD, never on the object:
`z.object({ notes: z.string().optional() })`.

**Do not annotate `execute`'s return type.** Nothing needs it — the result
is serialized to the model either way — and it reliably breaks the moment
the tool also returns an error, because `Promise<DrugInfo>` does not accept
`{ error: "not found" }`. Every such annotation eventually costs a build
round to widen into a union. Let it infer.

### Separate file pattern

For complex tools — `tools/` is a convention, any import path works:

```ts
// tools/roll_dice.ts
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export const rollDice = tool({
  description: "Roll dice",
  inputSchema: z.object({ sides: z.number() }),
  execute({ sides }) {
    return Math.floor(Math.random() * sides) + 1;
  },
});
```

```ts no-check
// agent.ts
import { agent } from "@alexkroman1/aai";
import { rollDice } from "./tools/roll_dice.ts";

export default agent({
  name: "Dice Agent",
  tools: { roll_dice: rollDice },
});
```

## Built-in tools

Enable via `builtinTools` in `agent()`. **When `builtinTools` is omitted, none
are enabled** — omitting the field and passing `[]` mean the same thing. Name
the ones you want; a built-in is something an agent asks for rather than
something it has to notice and switch off.

| Tool | Description | Params |
| --- | --- | --- |
| `web_search` | Search the web (DuckDuckGo) — no API key required | `query`, `max_results?` (default 5) |
| `visit_webpage` | Fetch URL to plain text | `url` |
| `get_page_design` | Fetch URL's raw HTML + CSS (style blocks and linked stylesheets) to study/mimic a site's design | `url` |
| `fetch_json` | HTTP GET a JSON API | `url`, `headers?` |
| `run_code` | Execute JS in the agent's sandbox — same authority as the agent's own tool code, output is what it logs (5s timeout) | `code` |
| `think` | Private reasoning scratchpad, no side effects | `thought` |
| `remember` | Save a confirmed fact to session notes | `key`, `value` |
| `recall` | Read session notes saved with `remember` | `key?` |
| `calculate` | Safe arithmetic evaluator, no code execution | `expression` |

**Every builtin in this table is a tool the MODEL calls — not a function
your code can call.** Listing one in `builtinTools` adds it to the model's
tool set; it does not import anything into `agent.ts`. There is no
`fetch_json()` you can call from a tool's `execute`.

So the two ways to reach an API are genuinely different designs, and both
are valid:

- **Declare the builtin** (`builtinTools: ["fetch_json"]`) when the MODEL
  should decide the URL and read the JSON — general lookups you cannot
  enumerate ahead of time.
- **Write your own tool** whose `execute` calls `fetch` when YOU own the
  URL and the shape — a specific endpoint, auth, or a response you want to
  reshape before the model sees it.

The network builtins take model-controlled URLs, so they are SSRF-screened
when the runtime is not inside a container (private/loopback blocked). Your
own tool code has open egress either way.

## Calling an external API from your own tool code

`fetch` inside a tool's `execute` works directly — no declaration needed,
identical under `aai dev` and deployed. This is the right choice when your
code owns the URL.

Reaching for the `fetch_json` builtin instead is a different design, not a
shortcut for the same one: it hands URL choice to the model. You cannot
call it from `execute` — see the builtin table above.

## Database API — `ctx.db`

Persistent SQL storage scoped per app, backed by the app's own Postgres
schema. Access via `ctx.db`:

```ts no-check
ctx.db.query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
```

One parameterized statement per call, `$1, $2…` placeholders — never
interpolate values into the SQL string. The rows come back as plain objects;
`jsonb` columns are returned already parsed (no `JSON.parse` needed).
A query returning more than 1000 rows throws — always bound reads with
`LIMIT` (paginate with `LIMIT`/`OFFSET`).

**The database must be enabled** or accessing `ctx.db` throws:

- CLI: `aai storage enable`
- Studio: Settings pane → Database → Enable database (covers both the
  preview and published agents, each with its own schema)
- `aai dev`: set `DATABASE_URL` in the project `.env`

Create tables lazily from tool code and upsert with `on conflict`:

```ts no-check
await ctx.db.query(`create table if not exists app_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
)`);
await ctx.db.query(
  "insert into app_state (key, value, updated_at) values ($1, $2::jsonb, now()) " +
    "on conflict (key) do update set value = excluded.value, updated_at = now()",
  ["user:123", JSON.stringify({ name: "Alex" })],
);
const rows = await ctx.db.query<{ value: { name: string } }>(
  "select value from app_state where key = $1",
  ["user:123"],
);
```

Use `ctx.db` for data that must outlive the session (saves, filed records,
user profiles). For scratch that only the current session needs, prefer
`ctx.state` (per-session mutable state — no storage required); the
`remember`/`recall` builtins likewise remain for session-scoped notes the
LLM manages itself.

## Custom UI — `client()`

File: `client.tsx` alongside `agent.ts`. Uses **React** (not Preact).
Always import `"@alexkroman1/aai-ui/styles.css"` first.

### Tier 1 — config only (default UI)

```tsx
/// <reference types="vite/client" />
import "@alexkroman1/aai-ui/styles.css";
import { client } from "@alexkroman1/aai-ui";

client({ name: "My Agent" });
```

### Tier 1 with sidebar

```tsx
/// <reference types="vite/client" />
import "@alexkroman1/aai-ui/styles.css";
import { client, useEvent } from "@alexkroman1/aai-ui";
import { useState } from "react";

function Sidebar() {
  const [items, setItems] = useState<string[]>([]);
  useEvent<{ item: string }>("new_item", (data) => {
    setItems((prev) => [...prev, data.item]);
  });
  return (
    <div className="p-4">
      {items.map((it, i) => <p key={i}>{it}</p>)}
    </div>
  );
}

client({ name: "My Agent", sidebar: Sidebar });
```

### Tier 2 — full custom component

```tsx
/// <reference types="vite/client" />
import "@alexkroman1/aai-ui/styles.css";
import { client, useSession } from "@alexkroman1/aai-ui";

function MyApp() {
  const { messages, userTranscript, started, running, start, toggle, end } =
    useSession();
  return (
    <div>
      {messages.map((m, i) => <p key={i}>{m.content}</p>)}
      {userTranscript != null && <p>{userTranscript || "..."}</p>}
      {!started ? (
        <button onClick={start}>Start</button>
      ) : (
        <>
          <button onClick={toggle}>{running ? "Stop" : "Resume"}</button>
          <button onClick={end}>End</button>
        </>
      )}
    </div>
  );
}

client({ component: MyApp });
```

### `client()` config

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | — | Header/start screen title (tier 1) |
| `component` | `ComponentType` | — | Custom root component (tier 2) |
| `sidebar` | `ComponentType` | — | Sidebar alongside default chat (tier 1) |
| `sidebarWidth` | `string` | `"18rem"` | CSS width of sidebar |
| `theme` | `ClientTheme` | — | `{ bg, primary, text, surface, border }` |
| `target` | `string \| HTMLElement` | `"#app"` | Mount target |
| `tools` | `ToolDisplayConfig` | — | Icon/label overrides per tool name |

**The two tiers are mostly exclusive.** `sidebar`, `sidebarWidth`, and
`tools` configure the default shell, so passing any of them alongside
`component` is a type error. `name` is the exception — it is allowed with a
custom component and becomes the page title, since there is no shell header
to put it in.

### `useSession()` return type

| Field | Type | Description |
| --- | --- | --- |
| `state` | `AgentState` | `"disconnected"` `"connecting"` `"ready"` `"listening"` `"thinking"` `"speaking"` `"error"` |
| `messages` | `ChatMessage[]` | `{ role, content }` |
| `toolCalls` | `ToolCallInfo[]` | `{ callId, name, args, status, result? }` |
| `customEvents` | `AgentCustomEvent[]` | `{ id, event, data }` from `ctx.send()` |
| `userTranscript` | `string \| null` | `null` = not speaking, `""` = speech detected, string = text |
| `agentTranscript` | `string \| null` | `null` = not speaking, string = streaming response |
| `error` | `SessionError \| null` | `{ code, message }` |
| `started` | `boolean` | Whether session started |
| `running` | `boolean` | Whether session active |

Methods: `start()`, `toggle()`, `end()`, `reset()`, `cancel()`,
`disconnect()`, `resetState()`.

- `end()` hangs up: it flips `started` back to `false` (a start-screen UI
  shows its Start control again) and the next `start()` is a brand-new
  session — fresh per-session tool state, greeting included. Use it for
  End/Hang up/New game buttons.
- `reset()` clears the conversation but keeps the call live (`started`
  stays `true`) — the control stays on Stop/Resume, and per-session tool
  state survives. Use it for a "clear chat" control, not for ending.

## UI hooks

**`useToolResult`** — fires once per completed tool call (deduplicates by
callId):

```ts no-check
useToolResult("tool_name", (result, toolCall) => { ... })          // one tool
useToolResult((toolName, result, toolCall) => { ... })             // all tools
useToolResult<ResultType>("tool_name", (result) => { ... })        // typed (optional)
```

`result` is the tool's return value, already JSON-parsed and untyped — read
fields off it directly (`result.price`). The type parameter is optional; add
it only when you want the shape checked.

**There is no global `JSX` namespace.** React 19 removed it, so
`JSX.Element` is `Cannot find namespace 'JSX'` (`TS2503`). Type a component's
return as `ReactNode` — `import type { ReactNode } from "react"` — which is
also what you want for anything that can be a string, an array, or null.

**`useAgentState`** — the agent's session state, pushed automatically:

```ts no-check
// agent.ts
export default agent({
  state: () => ({ cart: [] as Item[], staffPin: "" }),
  syncState: (s) => ({ cart: s.cart }),   // staffPin never leaves the server
  tools: { ... },
});

// client.tsx
const view = useAgentState<{ cart: Item[] }>();   // null until the first push
return <Cart items={view?.cart ?? []} />;
```

**Reach for this before wiring `useToolResult` into `useState`.** Without
it the pattern is: return a cart snapshot from every tool, declare a type
describing what those tools return, and mirror it into `useState` — three
things to keep in step, and the usual source of drift when you add a tool
and forget to return the snapshot from it.

`syncState` is a projection, not a flag, because state often holds things
that should not reach a browser (keys, PINs, scratch) or cannot be
serialized. Whatever it returns is exactly what the client receives. It runs
after every tool call and is sent only when the result changed.

**`useEvent`** — fires for custom events from `ctx.send()`:

```ts no-check
useEvent<DataType>("event_name", (data) => { ... })
```

Server: `ctx.send("order", { total: "$14.99" })` —
Client: `useEvent("order", (data) => ...)`.

**`useTheme`** — returns `{ bg, primary, text, surface, border }`.

**`useToolCallStart`** — fires when a tool call begins (status `"pending"`).

**Anti-pattern:** Do NOT use `useEffect` + `toolCalls` to build derived
state. Use `useToolResult` — it deduplicates. The `useEffect` pattern
re-processes every tool call on every render, causing duplicates.

## Components

Available from `@alexkroman1/aai-ui`:

| Component | Props | Description |
| --- | --- | --- |
| `StartScreen` | `children` (**required**)`, icon?, title?, subtitle?, buttonText?` | **Wrapper, never self-closing.** Shows the start card, then renders `children` — your whole app — once the session starts |
| `ChatView` | `icon?, title?` | Chat interface (header + messages + controls) |
| `SidebarLayout` | `sidebar, children, sidebarWidth?, sidebarPosition?` | Two-column layout |
| `MessageList` | — | Messages with auto-scroll, tool calls, transcript |
| `Controls` | — | Stop/Resume + New Conversation buttons |
| `Button` | — | Styled button |

The usual shape — note `StartScreen` **wraps** the app rather than sitting
beside it; writing `<StartScreen ... />` self-closing is a `TS2741:
Property 'children' is missing` build error:

```tsx
/// <reference types="vite/client" />
import "@alexkroman1/aai-ui/styles.css";
import { ChatView, client, StartScreen } from "@alexkroman1/aai-ui";

function PizzaApp() {
  return (
    <StartScreen title="Pizza Palace" subtitle="Voice-powered ordering">
      <ChatView />
    </StartScreen>
  );
}

client({ component: PizzaApp });
```

## Styling

- **Tailwind CSS v4** — compiled at bundle time, configured via CSS.
  Do NOT create `tailwind.config.js` — it will be ignored.
- Use Tailwind classes for layout, `useTheme()` for dynamic colors.
- Set theme: `client({ theme: { bg, primary, text, surface, border } })`.
- Override CSS custom properties for extra tokens:
  `--color-aai-*`, `--radius-aai`, `--font-aai`.
- Always import `"@alexkroman1/aai-ui/styles.css"` at the top of `client.tsx`.

### Design guidelines

A custom UI should look deliberate, not like boilerplate. When building or
restyling a `client.tsx`:

- **Color:** pick one primary brand color, 2-3 neutrals (white/grays/black
  variants), and at most 1-2 accents — 3-5 colors total. Avoid gradients
  unless asked. If you override an element's background color, also set its
  text color so contrast holds.
- **Typography:** at most 2 font families — one for headings, one for body.
  Body text 14px or larger with a relaxed line height (`leading-relaxed`).
- **Layout:** design mobile-first, then enhance with responsive prefixes
  (`md:`, `lg:`). Prefer flexbox (`flex items-center justify-between`);
  use grid only for genuinely two-dimensional layouts; avoid absolute
  positioning unless nothing else works.
- **Tailwind:** stay on the spacing scale (`p-4`, never `p-[16px]`), use
  `gap-*` between siblings rather than per-child margins, and wrap headings
  and key copy in `text-balance` or `text-pretty`.
- **Accessibility:** semantic elements (`main`, `header`, `button`), alt
  text on meaningful images, `sr-only` labels on icon-only buttons.
- **No filler:** no emojis as icons, no decorative gradient blobs or
  abstract placeholder shapes, no lorem-ipsum-looking content.

## Secrets

Never hardcode secrets in agent code.

- **Local dev:** `.env` in project root. Only declared keys available via
  `ctx.env`.
- **Production:** `npx @alexkroman1/aai-cli secret put NAME`
- **Access:** `ctx.env.MY_KEY` in tool execute functions.
- **AssemblyAI key:** `npx @alexkroman1/aai-cli login` links your account and
  stores the key globally — the only way the CLI authenticates. No `.env`
  entry needed. For CI, point `AAI_CONFIG_DIR` at a config dir holding a
  logged-in key (an exported `ASSEMBLYAI_API_KEY` does not authenticate).

## Voice rules for systemPrompt

- Short, punchy sentences — optimize for speech, not text
- Never mention "search results" or "sources" — speak as if knowledge is
  your own
- No visual formatting (bullets, bold) — use "First", "Next", "Finally"
- Lead with the most important information
- Keep answers to 1-3 sentences
- No exclamation points — calm, conversational tone
- No hedging ("It seems that", "I believe")
- Define personality, tone, and specialty
- Include when and how to use each tool

Patterns by agent type:

- **Code execution:** "You MUST use run_code for ANY math, counting, or
  data processing. NEVER do mental math."
- **Research:** "Search first. Never guess or rely on memory for factual
  questions."
- **FAQ/support:** "Base answers strictly on your knowledge — don't guess."
- **Game/interactive:** "You ARE the game. Keep descriptions to 2-4
  sentences. No visual formatting."

## Gotchas

Common mistakes when working in aai projects:

- **Tool execute must return a value.** A missing return = `undefined` in
  LLM context = the model thinks the tool failed.
- **Filter large API responses before returning them from tools.** Return
  values are injected into LLM context. Truncate, summarize, or extract
  only what the model needs.
- **Declare only the pipeline stages you're changing.** Unset stages of
  `stt` / `llm` / `tts` default to AssemblyAI (omit all three for the full
  default pipeline; `voice` picks its TTS voice). S2S needs an explicit
  `s2s: assemblyAIS2s()` and takes no pipeline fields.
- **Never hardcode secrets.** Use `ctx.env.MY_KEY`. `.env` for local dev,
  `aai secret put` for production.
- **Don't use `useEffect` + `toolCalls` to derive state.** Use
  `useToolResult` — it deduplicates by callId. The useEffect pattern
  re-fires on every render and produces duplicates.
- **Always import `"@alexkroman1/aai-ui/styles.css"` first** in
  `client.tsx`. Missing this = unstyled UI.
- **Don't create `tailwind.config.js`.** Tailwind v4 is configured via
  CSS; the config file is ignored.
- **Voice prompts ≠ chat prompts.** No bullets, no bold, no exclamation
  points. See "Voice rules" above.
- **`fetch` to private IPs is blocked** (SSRF protection). Use public URLs.
- **`run_code` only executes on the deployed platform.** It runs inside the
  platform's Modal/Deno sandbox; the self-hosted `aai dev` server has no
  sandbox, so there `run_code` refuses with an error result. Deploy to test
  it end-to-end, or use the `calculate` builtin for simple arithmetic in dev.
- **`ctx.db` throws until the database is enabled.** Enable it with
  `aai storage enable` (CLI), Settings → Database (studio), or
  `DATABASE_URL` in `.env` (`aai dev`) before shipping tools that persist
  data. In the studio it takes effect when each agent next deploys — the
  preview redeploys itself, production on the next publish.
- **The database is per-app.** Rows are shared by every session of one
  deployment — key them yourself if sessions must not see each other's data
  (or keep session-scoped data in `ctx.state`).
- **Rime language codes are ISO 639-3** (3-letter, e.g. `"eng"`), not
  ISO 639-1 (`"en"`).

## Constraints

- Tool `execute` return values go into LLM context, capped at 4000 chars
  (a truncation marker replaces the tail) — filter large API responses
- Tool code uses plain `fetch` with open egress; the keyless web builtins
  screen private/internal IPs (SSRF) when running outside a sandbox
- Agent code runs in a sandboxed worker — use `fetch` for HTTP, `ctx.env`
  for secrets
- Tool execution timeout: 30 seconds
- `maxSteps` limits tool calls per turn (default 10) — lower it for a
  latency-sensitive agent. On reaching the cap the agent spends one more LLM
  step with tools switched off, so it answers with what it has instead of
  going silent mid-chain
- Tool returns `undefined` if execute function has no return statement —
  always return a value
