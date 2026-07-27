# aai Voice Agent

You are helping build a voice agent using the **aai** framework.

## Workflow

The fast loop: edit → `pnpm dev` (browser, talk to it) →
`pnpm test` (logic) → `pnpm build` (validate bundle).

1. **Iterate in `pnpm dev`** — hot reload + browser UI. Speak to the
   agent to verify behavior end-to-end. This is the primary feedback loop.
2. **Run `pnpm test` after logic changes** — vitest. Co-locate tests as
   `agent.test.ts` (see `pipeline-simple` template for a reference).
3. **Run `pnpm build` before declaring done** — bundles `agent.ts`,
   type-checks, and validates the manifest. Catches issues `dev` won't.
4. **Make small, focused changes** — verify each one before stacking the
   next.
5. **Look at templates before writing custom code** —
   `node_modules/@alexkroman1/aai-templates/templates/` has 14 working
   examples. Closest matches: `simple`, `pipeline-simple`, `web-researcher`,
   `solo-rpg`, `pizza-ordering`.

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
  styles.css          # Tailwind CSS entry point
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
  maxSteps?: number;                         // default: 5 — max tool calls per turn
  toolChoice?: "auto" | "required";          // default: "auto"
  idleTimeoutMs?: number;                    // disconnect after inactivity (ms)
  silenceTimeoutMs?: number;                 // pipeline only — assistant speaks up after this much user silence (ms)
  silencePrompt?: string;                    // instruction injected on silence timeout (requires silenceTimeoutMs)
  minBargeInWords?: number;                  // pipeline only — words before user speech interrupts the reply (default 2)
  interruptionMinDurationMs?: number;        // pipeline only — sustained speech (ms) before an interim barge-in interrupts (default 0 = off)
  endpointSettleMs?: number;                 // pipeline only — wait after an STT final before committing the turn (default 1500; 0 disables)
  completeSettleMs?: number;                 // pipeline only — shorter wait for clearly-complete finals (default 500)
  holdPhrase?: string;                       // pipeline only — spoken before a silent tool-call turn (default "One moment."; "" disables)
  falseInterruptionTimeoutMs?: number;       // pipeline only — resume an interrupted reply if no user turn commits (default 2000; 0 disables)
});
```

> When `stt`, `llm`, and `tts` are all provided, the agent runs in
> **Pipeline mode** — see the section below.

Minimal agent:

```ts
import { agent } from "@alexkroman1/aai";
export default agent({ name: "My Agent" });
```

System prompt from file:

```ts
import { agent } from "@alexkroman1/aai";
import systemPrompt from "./system-prompt.md";
export default agent({ name: "My Agent", systemPrompt });
```

## Pipeline mode

By default an agent runs in **S2S mode**: AssemblyAI's speech-to-speech
service handles STT, the LLM loop, and TTS in one socket. This is the
simplest path and what `agent({ name })` gives you.

**Pipeline mode** is opt-in. The host runs the LLM loop locally (Vercel AI
SDK) and you choose your own STT, LLM, and TTS providers. Use it when:

- you want a specific LLM (Anthropic, OpenAI, Gemini, Mistral, xAI, Groq,
  or 25+ models via the AssemblyAI LLM Gateway)
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
  stt: assemblyAI({ model: "u3pro-rt" }),
  llm: anthropic({ model: "claude-haiku-4-5" }),
  tts: cartesia(),
});
```

Tools, KV, `ctx`, and the UI all behave identically across modes. Only
the audio + LLM transport differs.

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
(interim transcripts only — committed turns always land). `endpointSettleMs` /
`completeSettleMs` tune how long the transport waits after an STT final
before committing the turn (aggregating disfluent multi-final utterances).
`holdPhrase` is spoken when a turn opens with a tool call and no speech.
`falseInterruptionTimeoutMs` resumes an interrupted reply when a barge-in
turns out to be noise (no user turn commits within the window).

## Providers

Provider SDKs are **optional peer dependencies**. Install only the SDKs
for the providers you actually use.

### STT — `@alexkroman1/aai/stt`

| Factory       | Default model           | Env var               |
| ------------- | ----------------------- | --------------------- |
| `assemblyAI`  | `"u3pro-rt"`            | `ASSEMBLYAI_API_KEY`  |
| `deepgram`    | `"nova-3"`              | `DEEPGRAM_API_KEY`    |
| `elevenlabs`  | `"scribe_v2_realtime"`  | `ELEVENLABS_API_KEY`  |
| `soniox`      | `"stt-rt-v3"`           | `SONIOX_API_KEY`      |

All STT factories accept `{ model?: string, ... }`. Bare calls
(`deepgram()`, `soniox()`, etc.) use the default model.

### LLM — `@alexkroman1/aai/llm`

| Factory     | SDK package           | Env var                          |
| ----------- | --------------------- | -------------------------------- |
| `anthropic` | `@ai-sdk/anthropic`   | `ANTHROPIC_API_KEY`              |
| `openai`    | `@ai-sdk/openai`      | `OPENAI_API_KEY`                 |
| `google`    | `@ai-sdk/google`      | `GOOGLE_GENERATIVE_AI_API_KEY`   |
| `mistral`   | `@ai-sdk/mistral`     | `MISTRAL_API_KEY`                |
| `xai`       | `@ai-sdk/xai`         | `XAI_API_KEY`                    |
| `groq`      | `@ai-sdk/groq`        | `GROQ_API_KEY`                   |
| `gateway`   | `ai` (built in)       | `AI_GATEWAY_API_KEY`             |
| `assemblyAI`| `@ai-sdk/openai`      | `ASSEMBLYAI_API_KEY`             |

LLM factories require `{ model: string }`. Example:
`anthropic({ model: "claude-haiku-4-5" })`.

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
  stt: assemblyAI({ model: "u3pro-rt" }),
  llm: assemblyAILlm({ model: "claude-sonnet-4-6" }),
  tts: cartesia(),
});
```

### TTS — `@alexkroman1/aai/tts`

| Factory    | Default voice                            | Env var               |
| ---------- | ---------------------------------------- | --------------------- |
| `cartesia` | `"f786b574-daa5-4673-aa0c-cbe3e8534c02"` | `CARTESIA_API_KEY`    |
| `rime`     | `"cove"` (model `mistv2`)                | `RIME_API_KEY`        |

Bare calls (`cartesia()`, `rime()`) use the defaults. Override with
`{ voice, model, language }`. **Rime quirk:** language uses ISO 639-3
three-letter codes (e.g. `"eng"` not `"en"`).

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

### `ctx` (ToolContext)

```ts
ctx.env: Readonly<Record<string, string>>     // secrets from .env / aai secret put
ctx.kv: Kv                                     // persistent KV store (see KV section)
ctx.messages: readonly Message[]               // conversation history [{role, content}]
ctx.sessionId: string                          // unique session ID
ctx.send(event: string, data: unknown): void   // push custom event to browser client
```

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
| `web_search` | Search the web (Brave) | `query`, `max_results?` (default 5) |
| `visit_webpage` | Fetch URL to plain text | `url` |
| `fetch_json` | HTTP GET a JSON API | `url`, `headers?` |
| `run_code` | Execute JS in sandbox (no net/fs, 5s timeout) | `code` |
| `think` | Private reasoning scratchpad, no side effects (on by default) | `thought` |
| `remember` | Save a confirmed fact to session notes (on by default) | `key`, `value` |
| `recall` | Read session notes saved with `remember` (on by default) | `key?` |
| `calculate` | Safe arithmetic evaluator, no code execution (on by default) | `expression` |

## KV API

Persistent key-value store scoped per agent deployment. Access via `ctx.kv`.

```ts
ctx.kv.get<T>(key: string): Promise<T | null>
ctx.kv.set(key: string, value: unknown, opts?: { expireIn?: number }): Promise<void>
ctx.kv.delete(keys: string | string[]): Promise<void>
```

- Values are JSON-serialized. Max value size: 64 KB.
- Use colon-prefixed keys: `"user:123"`, `"save:game"`.
- Scoped per deployment. New slug = fresh namespace.
- No key enumeration — maintain your own index key if needed.

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
useToolResult((toolName, result, toolCall) => { ... })             // all tools
useToolResult<ResultType>("tool_name", (result, toolCall) => { })  // single tool, typed
```

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
| `SidebarLayout` | `sidebar, children, sidebarWidth?, side?` | Two-column layout |
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
- **KV is per-deployment.** A new slug = fresh namespace. Don't expect
  data to survive `aai delete` + `aai deploy` with a different name.
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
- `maxSteps` limits tool calls per turn (default 5) — increase for
  multi-tool workflows
- KV reads return `null` after redeployment with a new slug
- Tool returns `undefined` if execute function has no return statement —
  always return a value
