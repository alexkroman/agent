# aai Voice Agent

You are helping build a voice agent using the **aai** framework.

## Workflow

The fast loop: edit → `pnpm dev` (browser, talk to it) →
`pnpm test` (logic) → `pnpm build` (validate bundle).

1. **Iterate in `pnpm dev`** — hot reload + browser UI. Speak to the
   agent to verify behavior end-to-end. This is the primary feedback loop.
2. **Run `pnpm test` after logic changes** — vitest. Co-locate tests as
   `agent.test.ts` (see `pipeline-simple` template for a reference).
   **The project starts with an `agent.test.ts`, and it is yours to
   maintain.** It asserts the agent's shape — name, providers, tool names —
   so rewriting the agent without updating it leaves a test asserting an
   agent that no longer exists. When a test fails after your change, decide
   which side is stale: updating the test to match the new agent is a normal
   fix, not a workaround. Do not delete a test to make it pass.
3. **Run `pnpm build` before declaring done** — bundles `agent.ts`,
   type-checks, and validates the manifest. Catches issues `dev` won't.
4. **Make small, focused changes** — verify each one before stacking the
   next.
5. **Look at templates before writing custom code** — the framework repo
   ships 15 working examples under `packages/aai-templates/templates/`
   (github.com/alexkroman/agent; `aai init --template <name>` scaffolds
   any of them). Closest matches: `simple`, `pipeline-simple`,
   `web-researcher`, `solo-rpg`, `pizza-ordering`.

## CLI

```sh
npx @alexkroman1/aai-cli init             # Scaffold a new agent
npx @alexkroman1/aai-cli dev              # Start local dev server
npx @alexkroman1/aai-cli test             # Run agent.test.ts via vitest
npx @alexkroman1/aai-cli build            # Bundle and validate
npx @alexkroman1/aai-cli deploy           # Deploy to production
npx @alexkroman1/aai-cli deploy -y        # Deploy without prompts
npx @alexkroman1/aai-cli delete           # Remove deployed agent
npx @alexkroman1/aai-cli secret put NAME  # Set a secret
npx @alexkroman1/aai-cli secret delete NAME
npx @alexkroman1/aai-cli secret list
```

The scaffold's `package.json` exposes `dev`, `build`, `test`, and `deploy`
as `pnpm <name>` shortcuts. Other commands (`init`, `delete`, `secret`)
are CLI-only.

## Project structure

```text
my-agent/
  agent.ts            # Agent definition (required)
  agent.test.ts       # Unit tests (optional)
  client.tsx          # Custom UI (optional, React)
  shared.ts           # Types shared between agent.ts and client.tsx
  system-prompt.md    # Long system prompts (optional, imported)
  tools/              # Tool files when too large for inline (optional)
  package.json
  tsconfig.json
  .env                # Local dev secrets (gitignored)
```

## `agent()` API

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: string;                              // required — display name
  systemPrompt?: string;                     // default: general voice assistant
  greeting?: string;                         // default: "Hey there..."
  sttPrompt?: string;                        // STT guidance for jargon/acronyms
  builtinTools?: BuiltinTool[];              // see built-in tools table
  tools?: Record<string, ToolDef>;
  maxSteps?: number;                         // default: 10 — max tool calls per turn
  toolChoice?: "auto" | "required";          // default: "auto"
  idleTimeoutMs?: number;                    // disconnect after inactivity (ms)
  silenceTimeoutMs?: number;                 // pipeline only — assistant speaks up after this much user silence (ms)
  silencePrompt?: string;                    // instruction injected on silence timeout (requires silenceTimeoutMs)
  minBargeInWords?: number;                  // pipeline only — words before user speech interrupts the reply (default 2)
  interruptionMinDurationMs?: number;        // pipeline only — sustained speech (ms) before an interim barge-in interrupts (default 0 = off)
  holdPhrase?: string;                       // pipeline only — spoken before a silent tool-call turn (default "One moment."; "" disables)
  falseInterruptionTimeoutMs?: number;       // pipeline only — resume an interrupted reply if no user turn commits (default 2000; 0 disables)
  state?: () => S;                           // per-session mutable state, exposed as ctx.state
                                             // (S is inferred; see "Typing ctx.state")
});
```

> When `stt`, `llm`, and `tts` are all provided, the agent runs in
> **Pipeline mode** — see the section below.

Minimal agent — a cascaded pipeline, which is what you should build unless
the user asks for the speech-to-speech API:

```ts
import { agent } from "@alexkroman1/aai";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { assemblyAI as assemblyAILlm } from "@alexkroman1/aai/llm";
import { assemblyAI as assemblyAITts } from "@alexkroman1/aai/tts";

export default agent({
  name: "My Agent",
  stt: assemblyAI({ model: "universal-3-5-pro" }),
  llm: assemblyAILlm({ model: "qwen3-next-80b-a3b" }),
  tts: assemblyAITts({ voice: "vera" }),
});
```

`agent({ name })` alone is legal and gives you S2S mode instead — see below.

System prompt from file:

```ts
import { agent } from "@alexkroman1/aai";
import systemPrompt from "./system-prompt.md?raw";
export default agent({ name: "My Agent", systemPrompt });
```

## Pipeline mode

Omitting `stt`/`llm`/`tts` gives **S2S mode**: AssemblyAI's speech-to-speech
service handles STT, the LLM loop, and TTS in one socket. Fewer moving
parts, but you cannot choose the model, swap a provider, or tune a stage.

**Prefer pipeline mode** — declare all three — unless the user specifically
asks for the speech-to-speech API. Nearly every template ships this way, and
it is what the App Builder defaults to. The host runs the LLM loop locally
(Vercel AI SDK) with your chosen STT, LLM, and TTS. You need it when:

- you want a specific LLM (Anthropic, OpenAI, Gemini, Mistral, xAI, Groq,
  hundreds of models via OpenRouter, or 25+ models via the AssemblyAI
  LLM Gateway)
- you want a specific STT model or TTS voice
- you need to swap providers without changing agent code

**The rule:** set all three of `stt`, `llm`, `tts` together, or none. A
partial config is rejected at parse time.

```ts
import { agent } from "@alexkroman1/aai";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { anthropic } from "@alexkroman1/aai/llm";
import { cartesia } from "@alexkroman1/aai/tts";

export default agent({
  name: "My Agent",
  stt: assemblyAI({ model: "universal-3-5-pro" }),
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
`interruptionMinDurationMs` adds an optional sustained-speech gate on top
(interim transcripts only — committed turns always land). End-of-turn
detection (how long a pause ends the user's turn) belongs to the STT
provider: `assemblyAI({ minTurnSilenceMs })` / `deepgram({ endpointing })`,
both defaulting to 1500 ms so mid-utterance pauses don't split a request.
`holdPhrase` is spoken when a turn opens with a tool call and no speech.
`falseInterruptionTimeoutMs` resumes an interrupted reply when a barge-in
turns out to be noise (no user turn commits within the window).

## Providers

Provider SDKs are **optional peer dependencies**. Install only the SDKs
for the providers you actually use.

### STT — `@alexkroman1/aai/stt`

| Factory       | Default model            | Env var              |
| ------------- | ------------------------ | -------------------- |
| `assemblyAI`  | `"universal-3-5-pro"`    | `ASSEMBLYAI_API_KEY` |
| `deepgram`    | `"nova-3"`               | `DEEPGRAM_API_KEY`   |
| `elevenlabs`  | `"scribe_v2_realtime"`   | `ELEVENLABS_API_KEY` |
| `soniox`      | `"stt-rt-v3"`            | `SONIOX_API_KEY`     |

All STT factories accept `{ model?: string, ... }`. Bare calls
(`deepgram()`, `soniox()`, etc.) use the default model.

`assemblyAI` accepts an optional `region: "eu"` for EU data residency —
it routes streaming transcription to AssemblyAI's EU endpoints. EU-region
API keys require it; the US endpoints reject them. Example:
`assemblyAI({ model: "universal-3-5-pro", region: "eu" })`.

### LLM — `@alexkroman1/aai/llm`

| Factory     | SDK package           | Env var                          |
| ----------- | --------------------- | -------------------------------- |
| `anthropic` | `@ai-sdk/anthropic`   | `ANTHROPIC_API_KEY`              |
| `openai`    | `@ai-sdk/openai`      | `OPENAI_API_KEY`                 |
| `google`    | `@ai-sdk/google`      | `GOOGLE_GENERATIVE_AI_API_KEY`   |
| `mistral`   | `@ai-sdk/mistral`     | `MISTRAL_API_KEY`                |
| `xai`       | `@ai-sdk/xai`         | `XAI_API_KEY`                    |
| `groq`      | `@ai-sdk/groq`        | `GROQ_API_KEY`                   |
| `openrouter`| `@ai-sdk/openai`      | `OPENROUTER_API_KEY`             |
| `gateway`   | `ai` (built in)       | `AI_GATEWAY_API_KEY`             |
| `assemblyAI`| `@ai-sdk/openai`      | `ASSEMBLYAI_API_KEY`             |

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

`assemblyAI` routes through the [AssemblyAI LLM
Gateway](https://www.assemblyai.com/docs/llm-gateway) — an
OpenAI-compatible endpoint fronting 25+ models (Claude, GPT, Gemini,
etc.) with the same API key as AssemblyAI STT. It accepts an optional
`region: "eu"` for EU data residency. It shares its name with the STT
factory, so alias one when using both:

```ts
import { assemblyAI } from "@alexkroman1/aai/stt";
import { assemblyAI as assemblyAILlm } from "@alexkroman1/aai/llm";

export default agent({
  name: "My Agent",
  stt: assemblyAI({ model: "universal-3-5-pro" }),
  llm: assemblyAILlm({ model: "claude-sonnet-4-6" }),
  tts: cartesia(),
});
```

An all-AssemblyAI pipeline — one provider, one key:

```ts
import { agent } from "@alexkroman1/aai";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { assemblyAI as assemblyAILlm } from "@alexkroman1/aai/llm";
import { assemblyAI as assemblyAITts } from "@alexkroman1/aai/tts";

export default agent({
  name: "My Agent",
  stt: assemblyAI({ model: "universal-3-5-pro" }),
  llm: assemblyAILlm({ model: "gemini-2.5-flash-lite" }),
  tts: assemblyAITts({ voice: "vera" }),
});
```

### TTS — `@alexkroman1/aai/tts`

| Factory      | Default voice                            | Env var              |
| ------------ | ---------------------------------------- | -------------------- |
| `assemblyAI` | `"vera"`                                 | `ASSEMBLYAI_API_KEY` |
| `cartesia`   | `"f786b574-daa5-4673-aa0c-cbe3e8534c02"` | `CARTESIA_API_KEY`   |
| `rime`       | `"cove"` (model `mistv2`)                | `RIME_API_KEY`       |

Bare calls (`assemblyAI()`, `cartesia()`, `rime()`) use the defaults.
Override with `{ voice, model, language }`.

**AssemblyAI TTS** shares `ASSEMBLYAI_API_KEY` with AssemblyAI STT and the
LLM Gateway, so an all-AssemblyAI pipeline needs exactly one secret. Each
voice speaks one language — English includes `vera`, `michael`, `alba`,
`jane`, `george`, `mary`, `paul`; non-English are `estelle` (fr),
`giovanni` (it), `juergen` (de), `lola` (es), `rafael` (pt). Set
`language` only alongside a voice that speaks it, as an ISO 639-1 code —
`"en"`, `"fr"`, `"de"`, `"it"`, `"pt"`, `"es"` are the six the catalog
covers, and the SDK translates each to the full name the service wants.
Anything else fails at session start. Because the factory is named
`assemblyAI` in `/stt`, `/llm`, and `/tts`, alias on import.

**Rime quirk:** language uses ISO 639-3 three-letter codes (e.g. `"eng"`
not `"en"`).

Set provider keys the same way as any secret: `.env` for local dev,
`aai secret put` for production.

## `tool()` API

```ts
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

const myTool = tool({
  description: string;           // shown to LLM — decides when to call
  parameters?: z.ZodObject;      // Zod schema (omit for no-arg tools)
  execute(args, ctx): unknown;   // sync or async
});
```

`execute` may call `fetch` directly — tool code reaches external APIs the
same way in `aai dev` and deployed.

### `ctx` (ToolContext)

```ts
ctx.env: Readonly<Record<string, string>>     // secrets from .env / aai secret put
ctx.state: S                                   // per-session mutable state (agent's `state` factory)
ctx.db: Db                                     // SQL database, needs storage enabled (see Database section)
ctx.messages: readonly Message[]               // conversation history [{role, content}]
ctx.sessionId: string                          // unique session ID
ctx.send(event: string, data: unknown): void   // push custom event to browser client
ctx.generate(opts): Promise<{ text, object? }> // one-shot LLM call (host-side)
```

**Typing `ctx.state` is optional.** `ctx.state` is untyped by default, and
the project's tsconfig turns off `noImplicitAny`, so both of these compile
with no annotations and no errors:

```ts
ctx.state.count++;
ctx.state.incidents.filter((i) => i.status === "open");
```

Write the code first. Do NOT add type annotations defensively — nothing
requires them, and time spent on them is time not spent on the agent.

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
`ToolDef`, `Message`, `ToolResultMap`, provider types. A plain
`import { ToolContext }` fails; use `import type { ToolContext }`, or
`import { agent, type ToolContext }` to combine with value imports.

`ctx.generate({ prompt, system?, llm?, schema?, temperature?, maxOutputTokens? })`
runs one LLM generation on the host. It defaults to the agent's pipeline
`llm`; pass an `llm` descriptor (from `@alexkroman1/aai/llm`) to use another
provider whose API key is in the agent's secrets — that's also how S2S
agents use it. `schema` must be a **plain JSON Schema object** (use
`z.toJSONSchema(...)`), never a Zod schema.

### Inline tool example

```ts
import { agent, tool } from "@alexkroman1/aai";
import { z } from "zod";

export default agent({
  name: "Weather Agent",
  tools: {
    get_weather: tool({
      description: "Get current weather for a city",
      parameters: z.object({
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
  parameters: z.object({ sides: z.number() }),
  execute({ sides }) {
    return Math.floor(Math.random() * sides) + 1;
  },
});
```

```ts
// agent.ts
import { agent } from "@alexkroman1/aai";
import { rollDice } from "./tools/roll_dice.ts";

export default agent({
  name: "Dice Agent",
  tools: { roll_dice: rollDice },
});
```

## Built-in tools

Enable via `builtinTools` in `agent()`. When `builtinTools` is omitted, the
cognitive defaults (`think`, `remember`, `recall`, `calculate`) are enabled;
set `builtinTools` explicitly (including `[]`) to override.

| Tool | Description | Params |
| --- | --- | --- |
| `web_search` | Search the web (DuckDuckGo) — no API key required | `query`, `max_results?` (default 5) |
| `visit_webpage` | Fetch URL to plain text | `url` |
| `get_page_design` | Fetch URL's raw HTML + CSS (style blocks and linked stylesheets) to study/mimic a site's design | `url` |
| `fetch_json` | HTTP GET a JSON API | `url`, `headers?` |
| `run_code` | Execute JS in sandbox (no net/fs, 5s timeout) | `code` |
| `think` | Private reasoning scratchpad, no side effects (on by default) | `thought` |
| `remember` | Save a confirmed fact to session notes (on by default) | `key`, `value` |
| `recall` | Read session notes saved with `remember` (on by default) | `key?` |
| `calculate` | Safe arithmetic evaluator, no code execution (on by default) | `expression` |

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

```ts
ctx.db.query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
```

One parameterized statement per call, `$1, $2…` placeholders — never
interpolate values into the SQL string. The rows come back as plain objects;
`jsonb` columns are returned already parsed (no `JSON.parse` needed).
A query returning more than 1000 rows throws — always bound reads with
`LIMIT` (paginate with `LIMIT`/`OFFSET`).

**Storage must be enabled** or accessing `ctx.db` throws:

- CLI: `aai storage enable`
- Studio: the Storage toggle
- `aai dev`: set `DATABASE_URL` in the project `.env`

Create tables lazily from tool code and upsert with `on conflict`:

```ts
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
import "@alexkroman1/aai-ui/styles.css";
import { client } from "@alexkroman1/aai-ui";

client({ name: "My Agent" });
```

### Tier 1 with sidebar

```tsx
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
import "@alexkroman1/aai-ui/styles.css";
import { client, useSession } from "@alexkroman1/aai-ui";

function MyApp() {
  const { messages, userTranscript, started, running, start, toggle, reset } =
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
          <button onClick={reset}>Reset</button>
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

**The two tiers are exclusive.** `name`, `sidebar`, `sidebarWidth`, and
`tools` configure the default shell, so passing any of them alongside
`component` is a type error — and a cryptic one, reported as *"Type 'string'
is not assignable to type 'undefined'"*. With a custom component you own the
whole page, so pass `component` alone and render the title yourself.

### `useSession()` return type

| Field | Type | Description |
| --- | --- | --- |
| `state` | `AgentState` | `"disconnected"` `"connecting"` `"ready"` `"listening"` `"thinking"` `"speaking"` `"error"` |
| `messages` | `ChatMessage[]` | `{ role, content }` |
| `toolCalls` | `ToolCallInfo[]` | `{ callId, name, args, status, result? }` |
| `customEvents` | `CustomEvent[]` | `{ id, event, data }` from `ctx.send()` |
| `userTranscript` | `string \| null` | `null` = not speaking, `""` = speech detected, string = text |
| `agentTranscript` | `string \| null` | `null` = not speaking, string = streaming response |
| `error` | `SessionError \| null` | `{ code, message }` |
| `started` | `boolean` | Whether session started |
| `running` | `boolean` | Whether session active |

Methods: `start()`, `toggle()`, `reset()`, `cancel()`, `disconnect()`,
`resetState()`.

## UI hooks

**`useToolResult`** — fires once per completed tool call (deduplicates by
callId):

```ts
useToolResult("tool_name", (result, toolCall) => { ... })          // one tool
useToolResult((toolName, result, toolCall) => { ... })             // all tools
useToolResult<ResultType>("tool_name", (result) => { ... })        // typed (optional)
```

`result` is the tool's return value, already JSON-parsed and untyped — read
fields off it directly (`result.price`). The type parameter is optional; add
it only when you want the shape checked.

**`useEvent`** — fires for custom events from `ctx.send()`:

```ts
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
| `StartScreen` | `children, icon?, title?, subtitle?, buttonText?` | Centered start card; renders children after start |
| `ChatView` | `icon?, title?` | Chat interface (header + messages + controls) |
| `SidebarLayout` | `sidebar, children, sidebarWidth?, sidebarPosition?` | Two-column layout |
| `MessageList` | — | Messages with auto-scroll, tool calls, transcript |
| `Controls` | — | Stop/Resume + New Conversation buttons |
| `Button` | — | Styled button |

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
- **AssemblyAI key:** CLI prompts on first use, stores globally. No `.env`
  entry needed. For CI, set `ASSEMBLYAI_API_KEY` env var.

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
- **Pipeline mode requires all three of `stt` / `llm` / `tts`.** Partial
  configs are rejected at parse time. Use S2S (omit all three) if you
  don't need provider control.
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
- **`ctx.db` throws until storage is enabled.** Enable it with
  `aai storage enable` (CLI), the Storage toggle (studio), or `DATABASE_URL`
  in `.env` (`aai dev`) before shipping tools that persist data.
- **The database is per-app.** Rows are shared by every session of one
  deployment — key them yourself if sessions must not see each other's data
  (or keep session-scoped data in `ctx.state`).
- **Rime language codes are ISO 639-3** (3-letter, e.g. `"eng"`), not
  ISO 639-1 (`"en"`).

## Constraints

- Tool `execute` return values go into LLM context — filter and truncate
  large API responses
- `fetch` is proxied through the host; private/internal IPs are blocked
  (SSRF protection)
- Agent code runs in a sandboxed worker — use `fetch` for HTTP, `ctx.env`
  for secrets
- Tool execution timeout: 30 seconds
- `maxSteps` limits tool calls per turn (default 10) — increase for
  multi-tool workflows
- Tool returns `undefined` if execute function has no return statement —
  always return a value
