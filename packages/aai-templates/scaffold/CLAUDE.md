# aai Voice Agent

You are helping build a voice agent using the **aai** framework.

## Workflow

1. After every change, run `npx @alexkroman1/aai-cli build` to validate
2. Make small, focused changes; verify each before moving on
3. Check existing templates before writing custom code — see
   `node_modules/@alexkroman1/aai-cli/templates/` for working examples

## CLI

```sh
npx @alexkroman1/aai-cli init             # Scaffold a new agent
npx @alexkroman1/aai-cli dev              # Start local dev server
npx @alexkroman1/aai-cli build            # Bundle and validate
npx @alexkroman1/aai-cli deploy           # Deploy to production
npx @alexkroman1/aai-cli deploy -y        # Deploy without prompts
npx @alexkroman1/aai-cli delete           # Remove deployed agent
npx @alexkroman1/aai-cli secret put NAME  # Set a secret
npx @alexkroman1/aai-cli secret delete NAME
npx @alexkroman1/aai-cli secret list
```

## Project structure

```text
my-agent/
  agent.ts            # Agent definition (required)
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
});
```

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

Enable via `builtinTools` in `agent()`.

| Tool | Description | Params |
| --- | --- | --- |
| `web_search` | Search the web (Brave) | `query`, `max_results?` (default 5) |
| `visit_webpage` | Fetch URL to plain text | `url` |
| `fetch_json` | HTTP GET a JSON API | `url`, `headers?` |
| `run_code` | Execute JS in sandbox (no net/fs, 5s timeout) | `code` |

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
