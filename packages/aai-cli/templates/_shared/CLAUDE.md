# aai Voice Agent Project

You are helping a user build a voice agent using the **aai** framework.

## Workflow

1. **Understand** — Restate what the user wants to build. If the request is
   vague, ask a clarifying question before writing code.
2. **Check existing work** — Look for a template or built-in tool that already
   does what the user needs before writing custom code.
3. **Start minimal** — Scaffold from the closest template, then layer on
   customizations. Don't over-engineer the first version.
4. **Verify** — After every change, run `aai build` to validate the bundle and
   catch errors. Fix all errors before presenting work to the user.
5. **Iterate** — Make small, focused changes. Verify each change works before
   moving on.

## Key rules

- Every agent lives in `agent.ts` and exports a default `defineAgent()` call
- Custom UI goes in `client.tsx` alongside `agent.ts` — **uses Preact, not
  React** (import from `preact/hooks`, not `react`)
- Optimize `instructions` for spoken conversation — short sentences, no visual
  formatting, no exclamation points
- Never hardcode secrets — use `aai secret put` and access via `ctx.env`
- Tool `execute` return values go into LLM context — filter and truncate large
  API responses
- Agent code runs in a sandboxed worker — use `fetch` (proxied) for HTTP,
  `ctx.env` for secrets

## CLI commands

```sh
aai init                 # Scaffold a new agent (uses simple template)
aai init -t <template>   # Scaffold from a specific template
aai dev                  # Start local dev server
aai test                 # Run agent tests (vitest)
aai build                # Run tests, then bundle and validate (skip tests with --skipTests)
aai deploy               # Bundle and deploy to production
aai deploy -y            # Deploy without prompts
aai deploy --dry-run     # Validate and bundle without deploying
aai secret put <NAME>    # Set a secret on the server (prompts for value)
aai secret delete <NAME> # Remove a secret
aai secret list          # List secret names
aai rag <url>            # Ingest a site's llms-full.txt into the vector store
aai link                 # Link local workspace packages (dev only)
aai unlink               # Restore published package versions (reverses link)
```

## Templates

Before writing an agent from scratch, choose the closest template and scaffold
with `aai init -t <template_name>`.

| Template            | Description                                                                        |
| ------------------- | ---------------------------------------------------------------------------------- |
| `simple`            | Minimal starter with web_search, visit_webpage, fetch_json, run_code. **Default.** |
| `web-researcher`    | Research assistant — web search + page visits for detailed answers                 |
| `smart-research`    | Phase-based research (gather → analyze → respond) with dynamic tool filtering      |
| `memory-agent`      | Persistent KV storage — remembers facts and preferences across conversations       |
| `code-interpreter`  | Writes and runs JavaScript for math, calculations, data processing                 |
| `math-buddy`        | Calculations, unit conversions, dice rolls via run_code                            |
| `health-assistant`  | Medication lookup, drug interactions, BMI, symptom guidance                        |
| `personal-finance`  | Currency conversion, crypto prices, loan calculations, savings projections         |
| `travel-concierge`  | Trip planning, weather, flights, hotels, currency conversion                       |
| `night-owl`         | Movie/music/book recs by mood, sleep calculator. **Has custom UI.**                |
| `pizza-ordering`    | Pizza order-taker with dynamic cart sidebar. **Has custom UI.**                    |
| `dispatch-center`   | 911 dispatch with incident triage and resource assignment. **Has custom UI.**      |
| `infocom-adventure` | Zork-style text adventure with state, puzzles, inventory. **Has custom UI.**       |
| `solo-rpg`          | Solo dark-fantasy RPG with dice, oaths, combat, save/load. **Has custom UI.**      |
| `middleware`        | Middleware demo: rate limiting, PII redaction, caching, analytics                  |
| `embedded-assets`   | FAQ bot using embedded JSON knowledge (no web search)                              |
| `support`           | RAG-powered support agent using vector_search (AssemblyAI docs example)            |
| `test-patterns`     | Demonstrates every testable agent pattern (tools, hooks, middleware, state)        |

## Minimal agent

Every agent lives in `agent.ts` and exports a default `defineAgent()` call:

```ts
import { defineAgent } from "@alexkroman1/aai";

export default defineAgent({
  name: "My Agent",
  instructions: "You are a helpful assistant that...",
  greeting: "Hey there. What can I help you with?",
});
```

### Imports

```ts
import { createToolFactory, defineAgent, defineTool } from "@alexkroman1/aai"; // defineAgent + helpers
import type { BeforeStepResult, BuiltinTool, HookContext, Middleware, StepInfo, ToolContext } from "@alexkroman1/aai";
import { z } from "zod"; // Tools with typed params (included in package.json)
```

## Agent configuration

```ts
defineAgent({
  // Core
  name: string;              // Required: display name
  instructions?: string;     // System prompt (default: general voice assistant)
  greeting?: string;         // Spoken on connect (default: "Hey, how can I help you?")
  // Speech
  sttPrompt?: string;        // STT guidance for jargon, names, acronyms

  // Tools
  builtinTools?: BuiltinTool[];
  tools?: Record<string, ToolDef>;
  toolChoice?: ToolChoice;   // "auto" | "required" | "none" | { type: "tool", toolName }
  activeTools?: string[];    // Default active tools per turn (subset of all tools)
  maxSteps?: number | ((ctx: HookContext) => number);

  // State
  state?: () => S;           // Factory for per-session state

  // Lifecycle hooks
  onConnect?: (ctx: HookContext) => void | Promise<void>;
  onDisconnect?: (ctx: HookContext) => void | Promise<void>;
  onError?: (error: Error, ctx?: HookContext) => void;
  onTurn?: (text: string, ctx: HookContext) => void | Promise<void>;
  onStep?: (step: StepInfo, ctx: HookContext) => void | Promise<void>;
  onBeforeStep?: (stepNumber: number, ctx: HookContext) =>
    BeforeStepResult | Promise<BeforeStepResult>;

  // Middleware
  middleware?: Middleware[];   // Composable interceptors (see below)
});
```

Use `sttPrompt` for domain-specific vocabulary:

```ts
export default defineAgent({
  name: "Tech Support",
  sttPrompt: "Transcribe technical terms: Kubernetes, gRPC, PostgreSQL",
});
```

### Writing good `instructions`

Optimize for spoken conversation:

- Short, punchy sentences — optimize for speech, not text
- Never mention "search results" or "sources" — speak as if knowledge is your
  own
- No visual formatting ("bullet point", "bold") — use "First", "Next", "Finally"
- Lead with the most important information
- Be concise and confident — no hedging ("It seems that", "I believe")
- No exclamation points — calm, conversational tone
- Define personality, tone, and specialty
- Include when and how to use each tool

**Patterns by agent type:**

- **Code execution** — "You MUST use the run_code tool for ANY question involving
  math, counting, or data processing. NEVER do mental math."
- **Research** — "Search first. Never guess or rely on memory for factual
  questions. Use visit_webpage when search snippets aren't detailed enough."
- **FAQ/support** — "Always use vector_search before answering. Base answers
  strictly on retrieved docs — don't guess."
- **API-calling** — List endpoints directly in instructions so the LLM knows
  what's available and what each returns.
- **Game/interactive** — "You ARE the game. Keep descriptions to two to four
  sentences. No visual formatting."

### Environment variables

Secrets are managed via the CLI and injected at runtime as `ctx.env`. Never
hardcode secrets in `agent.ts`.

```sh
aai secret put MY_API_KEY    # Set (prompts for value)
aai secret list              # List names
aai secret delete MY_API_KEY # Remove
```

Access in tool code: `ctx.env.MY_API_KEY` (see "Fetching external APIs" below).

## Tools

### Custom tools

Define tools as plain objects in the `tools` record. The `parameters` field
takes a Zod schema for type-safe argument inference:

```ts
import { defineAgent, defineTool } from "@alexkroman1/aai";
import { z } from "zod";

export default defineAgent({
  name: "Weather Agent",
  tools: {
    get_weather: defineTool({
      description: "Get current weather for a city",
      parameters: z.object({
        city: z.string().describe("City name"),
      }),
      execute: async ({ city }, ctx) => {
        // city is typed as string (inferred from Zod schema)
        const data = await fetch(
          `https://api.example.com/weather?q=${city}`,
        );
        return data.json();
      },
    }),

    // No-parameter tools — omit `parameters` and `defineTool()` wrapper
    list_items: {
      description: "List all items",
      execute: () => items,
    },
  },
});
```

**Important:** Wrap tool definitions in `defineTool()` to get typed `args`
inferred from the Zod `parameters` schema. Without `defineTool()`, args are
untyped.

**Typed state in tools:** When your agent uses typed session state, use
`createToolFactory` to avoid verbose generics on every tool:

```ts
import { createToolFactory, defineAgent } from "@alexkroman1/aai";
import { z } from "zod";

interface MyState { items: string[] }
const tool = createToolFactory<MyState>();

export default defineAgent<MyState>({
  name: "my-agent",
  state: () => ({ items: [] }),
  tools: {
    add_item: tool({
      description: "Add an item",
      parameters: z.object({ item: z.string() }),
      execute: ({ item }, ctx) => {
        ctx.state.items.push(item); // ctx.state is typed as MyState
      },
    }),
  },
});
```

Zod schema patterns:

```ts
parameters: z.object({
  query: z.string().describe("Search query"),
  category: z.enum(["a", "b", "c"]),
  count: z.number().describe("How many"),
  label: z.string().describe("Optional label").optional(),
}),
```

### Built-in tools

Enable via `builtinTools`.

| Tool            | Description                                    | Params                              |
| --------------- | ---------------------------------------------- | ----------------------------------- |
| `web_search`    | Search the web (Brave Search)                  | `query`, `max_results?` (default 5) |
| `visit_webpage` | Fetch URL → plain text                         | `url`                               |
| `fetch_json`    | HTTP GET a JSON API                            | `url`, `headers?`                   |
| `run_code`      | Execute JS in sandbox (no net/fs, 5s timeout)  | `code`                              |
| `vector_search` | Search the agent's RAG knowledge base          | `query`, `topK?` (default 5)        |
| `memory`        | Persistent KV memory (4 tools, see below)      | —                                   |

The agentic loop runs up to `maxSteps` iterations (default 5) and stops when the
LLM produces a text response.

### Tool context

Every `execute` function and lifecycle hook receives a context object:

```ts
ctx.env; // Record<string, string> — secrets from `aai secret put`
ctx.state; // per-session state
ctx.kv; // persistent KV store
ctx.vector; // VectorStore — vector store for RAG (tools only)
ctx.messages; // readonly Message[] — conversation history (tools only)
```

Hooks get `HookContext` (same but without `messages`).

**Timeouts:** Tool execution times out after **30 seconds**. Lifecycle hooks
(`onConnect`, `onTurn`, etc.) time out after **5 seconds**.

### Fetching external APIs

Use `fetch` in tool execute functions. Access secrets via `ctx.env`:

```ts
execute: async (args, ctx) => {
  const resp = await fetch(`https://api.example.com?q=${args.query}`, {
    headers: { Authorization: `Bearer ${ctx.env.MY_API_KEY}` },
  });
  if (!resp.ok) return { error: `${resp.status} ${resp.statusText}` };
  return resp.json();
},
```

`fetch` is proxied through the host — the worker has no direct network access.
Only public URLs are allowed (private/internal IPs are blocked by SSRF rules).

## State and storage

### Per-session state

For data that lasts only one connection (games, workflows, multi-step
processes). Fresh state is created per session and cleaned up on disconnect:

```ts
export default defineAgent({
  state: () => ({ score: 0, question: 0 }),
  tools: {
    answer: {
      description: "Submit an answer",
      parameters: z.object({ answer: z.string() }),
      execute: (args, ctx) => {
        const state = ctx.state as { score: number; question: number };
        state.question++;
        return state;
      },
    },
  },
});
```

### Persisting state across reconnects

Use the KV store to auto-save and auto-load state:

```ts
export default defineAgent({
  state: () => ({ score: 0, initialized: false }),
  onConnect: async (ctx) => {
    const saved = await ctx.kv.get("save:game");
    if (saved) Object.assign(ctx.state, saved);
  },
  onTurn: async (_text, ctx) => {
    await ctx.kv.set("save:game", ctx.state);
  },
});
```

This works for games, workflows,
or any agent where users expect to resume where they left off.

### Persistent storage (KV)

`ctx.kv` is a persistent key-value store scoped per agent. Values are
auto-serialized as JSON.

```ts
await ctx.kv.set("user:123", { name: "Alice" }); // save
await ctx.kv.set("temp:x", value, { expireIn: 60_000 }); // save with TTL (ms)
const user = await ctx.kv.get<User>("user:123"); // read (or null)
const notes = await ctx.kv.list("note:", { limit: 10, reverse: true }); // list by prefix
const allKeys = await ctx.kv.keys(); // all keys
const userKeys = await ctx.kv.keys("user:*"); // keys matching glob pattern
await ctx.kv.delete("user:123"); // delete
```

Keys are strings; use colon-separated prefixes (`"user:123"`). Max value: 64 KB.

`kv.list()` returns `KvEntry[]` where each entry has
`{ key: string, value: T }`.

### Memory tools (pre-built KV tools)

Add `"memory"` to `builtinTools` to give the agent four persistent KV tools:
`save_memory`, `recall_memory`, `list_memories`, and `forget_memory`.

```ts
import { defineAgent } from "@alexkroman1/aai";

export default defineAgent({
  name: "My Agent",
  builtinTools: ["memory"],
});
```

Keys use colon-separated prefixes (`"user:name"`, `"preference:color"`).

## Advanced patterns

### Step hooks

`onStep` — called after each LLM step (logging, analytics):

```ts
onStep: (step, ctx) => {
  console.log(`Step ${step.stepNumber}: ${step.toolCalls.length} tool calls`);
},
```

`onBeforeStep` — return `{ activeTools: [...] }` to filter tools per step:

```ts
state: () => ({ phase: "gather" }),
onBeforeStep: (stepNumber, ctx) => {
  const state = ctx.state as { phase: string };
  if (state.phase === "gather") {
    return { activeTools: ["search", "lookup"] };
  }
  return { activeTools: ["summarize"] };
},
```

### Tool choice

Control when the LLM uses tools:

```ts
toolChoice: "auto",     // Default — LLM decides when to use tools
toolChoice: "required", // Force a tool call every step (useful for research pipelines)
toolChoice: "none",     // Disable all tool use
toolChoice: { type: "tool", toolName: "search" }, // Force a specific tool
```

### Phase-based tool filtering

Combine `state`, `onBeforeStep`, and `activeTools` for multi-phase workflows:

```ts
state: () => ({ phase: "gather" as "gather" | "analyze" | "respond" }),
onBeforeStep: (_step, ctx) => {
  const state = ctx.state as { phase: string };
  if (state.phase === "gather") return { activeTools: ["web_search", "advance"] };
  if (state.phase === "analyze") return { activeTools: ["summarize", "advance"] };
  return { activeTools: [] }; // respond phase — LLM speaks freely
},
tools: {
  advance: {
    description: "Move to the next phase",
    execute: (_args, ctx) => {
      const state = ctx.state as { phase: string };
      if (state.phase === "gather") state.phase = "analyze";
      else if (state.phase === "analyze") state.phase = "respond";
      return { phase: state.phase };
    },
  },
},
```

### Static `activeTools`

Restrict which tools the LLM can use by default, without writing a hook:

```ts
export default defineAgent({
  builtinTools: ["web_search", "visit_webpage", "run_code"],
  tools: { summarize: {/* ... */} },
  activeTools: ["web_search", "summarize"], // Only these two are available
});
```

Use `onBeforeStep` to override `activeTools` dynamically per step.

### Middleware / interceptors

Middleware provides composable hooks for turns, tool calls, and output
filtering. Runs in array order for "before" hooks and reverse for "after".

```ts
import type { Middleware } from "@alexkroman1/aai";

const rateLimiter: Middleware = {
  name: "rate-limiter",
  beforeTurn: (text, ctx) => {
    // Return { block: true, reason: "..." } to block the turn
    // Return void to proceed
  },
  afterTurn: (text, ctx) => {
    // Run after a turn completes
  },
};

const piiRedactor: Middleware = {
  name: "pii-redactor",
  beforeOutput: (text, ctx) => {
    // Transform agent text before TTS. Return the filtered text.
    return text.replace(/\d{3}-\d{2}-\d{4}/g, "[SSN REDACTED]");
  },
};

const cacheMiddleware: Middleware = {
  name: "tool-cache",
  beforeToolCall: (toolName, args, ctx) => {
    // Return { result: "cached" } to skip execution
    // Return { block: true, reason: "denied" } to deny the call
    // Return { args: { ...modified } } to transform arguments
    // Return void to proceed normally
  },
  afterToolCall: (toolName, args, result, ctx) => {
    // Run after tool execution (e.g. cache the result)
  },
};

export default defineAgent({
  name: "My Agent",
  middleware: [rateLimiter, piiRedactor, cacheMiddleware],
});
```

See the `middleware` template (`aai init -t middleware`) for a full example.

### `maxSteps` — controlling the agentic loop

The `maxSteps` option limits how many tool calls the LLM can make in a single
turn before being forced to respond. Default is **5**.

**Choosing a value:** Count the maximum number of sequential tool calls your
agent needs in its longest workflow. For example, if a health-check workflow
calls `check_status` → `query_metrics` → `acknowledge_alert`, that's 3 steps.
Add a small buffer (1–2) for the LLM to self-correct or call an extra tool,
giving `maxSteps: 5`. Multi-tool workflows that chain 5+ calls may need 8–10.

**Observability:** When a turn uses tool calls, the SDK logs a `"Turn complete"`
message with `{ steps, agent }` and records the `aai.turn.steps` histogram
metric. Use this to monitor actual step usage and right-size your `maxSteps`.
When `maxSteps` is exceeded, a warning is logged automatically.

**Dynamic maxSteps** — use a function to vary the limit per turn based on
session state:

```ts
maxSteps: (ctx) => {
  const state = ctx.state as { complexity: string };
  return state.complexity === "complex" ? 10 : 5;
},
```

You can also monitor steps via the `onStep` hook:

```ts
onStep: (step, ctx) => {
  console.log(`[step ${step.stepNumber}] tools: ${step.toolCalls.map(t => t.toolName).join(", ")}`);
},
```

### Conversation history in tools

```ts
execute: (args, ctx) => {
  const userMessages = ctx.messages.filter(m => m.role === "user");
  return { turns: userMessages.length };
},
```

### Embedded knowledge

```ts
import knowledge from "./knowledge.json" with { type: "json" };

export default defineAgent({
  tools: {
    search_faq: {
      description: "Search the knowledge base",
      parameters: z.object({ query: z.string() }),
      execute: (args) =>
        knowledge.faqs.filter((f: { question: string }) =>
          f.question.toLowerCase().includes(args.query.toLowerCase())
        ),
    },
  },
});
```

### Using npm packages

Add packages to `package.json` dependencies:

```sh
npm install some-package
```

### Telemetry (OpenTelemetry)

The SDK automatically emits OpenTelemetry traces and metrics for the
STT→LLM→TTS pipeline. To collect them, install an OTel SDK and
configure it **before** importing aai:

```ts
// instrument.ts — import first in your entry point
import { NodeSDK } from "@opentelemetry/sdk-node";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";

new NodeSDK({
  metricReader: new PrometheusExporter({ port: 9091 }),
}).start();
```

Pre-built metrics (all prefixed `aai.`):

- `aai.session.count` / `aai.session.active` — session lifecycle
- `aai.turn.count` / `aai.turn.bargein.count` — user turns
- `aai.tool.call.count` / `aai.tool.call.duration` — tool execution
- `aai.tool.call.error.count` — tool errors
- `aai.s2s.connection.duration` / `aai.s2s.error.count` — S2S health

Trace spans: `ws.session`, `s2s.connection`, `tool.call` (with tool
name, call ID, agent, and session ID attributes).

For custom metrics or spans in your agent code:

```ts
import { meter, tracer } from "@alexkroman1/aai/telemetry";

const myCounter = meter.createCounter("my_agent.custom_event");

// In a tool:
execute: (args, ctx) => {
  myCounter.add(1, { tool: "my_tool" });
  return tracer.startActiveSpan("my_tool.work", (span) => {
    // ... do work ...
    span.end();
    return result;
  });
},
```

When no OTel SDK is configured, all calls are no-ops with zero
overhead.

## Custom UI (`client.tsx`)

> **Important:** The client UI uses **Preact**, not React. Import hooks from
> `preact/hooks` (e.g. `import { useState } from "preact/hooks"`), not from
> `"react"`. Importing from `"react"` will cause bundler errors.

Add `client.tsx` alongside `agent.ts`. Define a Preact component and call
`mount()` to render it. Use JSX syntax:

```tsx
import "aai-ui/styles.css";
import { mount, useSession } from "@alexkroman1/aai-ui";

function App() {
  const { session, started, running, start, toggle, reset } = useSession();
  const msgs = session.messages.value;
  const tx = session.userUtterance.value;
  return (
    <div>
      {msgs.map((m, i) => <p key={i}>{m.content}</p>)}
      {tx !== null && <p>{tx || "..."}</p>}
      {!started.value ? <button onClick={start}>Start</button> : (
        <>
          <button onClick={toggle}>{running.value ? "Stop" : "Resume"}</button>
          <button onClick={reset}>Reset</button>
        </>
      )}
    </div>
  );
}

mount(App);
```

**Rules:**

- Always import `"aai-ui/styles.css"` at the top — without it, default styles
  won't load
- Call `mount(YourComponent)` at the end of the file
- Use `.tsx` file extension for JSX syntax
- Import hooks from `preact/hooks` (`useEffect`, `useRef`, `useState`, etc.)
- Style with `style={{ color: "red" }}` or inject `<style>` for selectors,
  keyframes, media queries

### `mount()` options

```ts
mount(App, {
  target: "#app", // CSS selector or DOM element (default: "#app")
  platformUrl: "...", // Server URL (auto-derived from location.href)
  title: "My Agent", // Shown in header and start screen
  theme: { // CSS custom property overrides
    bg: "#101010", // Background color
    primary: "#fab283", // Accent color
    text: "#ffffff", // Text color
    surface: "#1a1a1a", // Card/surface color
    border: "#333333", // Border color
  },
});
```

`mount()` returns a `MountHandle` with `session`, `signals`, and `dispose()`.

### Built-in components

Import from `aai-ui`:

**Layout components:**

| Component       | Description                                          |
| --------------- | ---------------------------------------------------- |
| `App`           | Default full UI (StartScreen + ChatView)             |
| `StartScreen`   | Centered start card; renders children after start    |
| `ChatView`      | Chat interface (header + messages + controls)        |
| `SidebarLayout` | Two-column layout with sidebar + main area           |
| `Controls`      | Stop/Resume + New Conversation buttons               |
| `MessageList`   | Messages with auto-scroll, tool calls, transcript    |

`StartScreen` props: `{ children, icon?, title?, subtitle?, buttonText? }`
`SidebarLayout` props: `{ sidebar, children, width?, side? }`

**Atomic components:**

| Component           | Props                                   | Description                     |
| ------------------- | --------------------------------------- | ------------------------------- |
| `MessageBubble`     | `{ message: Message }`                  | Single message bubble           |
| `Transcript`        | `{ userUtterance: Signal<str\|null> }`  | Live STT text display           |
| `StateIndicator`    | `{ state: Signal<AgentState> }`         | Colored dot + state label       |
| `ErrorBanner`       | `{ error: Signal<SessionError\|null> }` | Red error box with message      |
| `ThinkingIndicator` | none                                    | Animated dots during processing |
| `ToolCallBlock`     | `{ toolCall: ToolCallInfo }`            | Collapsible tool call display   |

**Hooks:**

- `useAutoScroll()` — returns a `RefObject<HTMLDivElement>` to attach to a
  sentinel div. Auto-scrolls when messages or utterances change.
- `useMountConfig()` — returns the `title` and `theme` passed to `mount()`.

**Important:** Components that accept `Signal<T>` props (like `StateIndicator`,
`Transcript`, `ErrorBanner`) expect the Signal object itself, NOT `.value`. Pass
`session.state`, not `session.state.value`. Passing `.value` compiles but breaks
reactivity silently.

### Session signals (`useSession()`)

`useSession()` returns
`{ session, started, running, start, toggle, reset, dispose }`. Reactive agent
data lives on `session` (a `VoiceSession`); UI-only controls are top-level.

| Signal / field                 | Type                   | Description                                                     |
| ------------------------------ | ---------------------- | --------------------------------------------------------------- |
| `session.state.value`          | `AgentState`           | "disconnected", "connecting", "ready", "listening", etc.        |
| `session.messages.value`       | `Message[]`            | `{ role, content }` objects                                     |
| `session.toolCalls.value`      | `ToolCallInfo[]`       | `{ toolCallId, toolName, args, status, result? }` — tool calls  |
| `session.userUtterance.value`  | `string \| null`       | `null` = not speaking, `""` = speech detected, string = text    |
| `session.agentUtterance.value` | `string \| null`       | `null` = not speaking, string = streaming agent response text   |
| `session.error.value`          | `SessionError \| null` | `{ code, message }`                                             |
| `session.disconnected.value`   | `object \| null`       | `{ intentional: boolean }` when disconnected, `null` otherwise  |
| `started.value`                | `boolean`              | Whether session has been started                                |
| `running.value`                | `boolean`              | Whether session is active                                       |

**Methods:** `start()`, `toggle()`, `reset()`, `dispose()`

**Hooks:**

| Hook                                                 | Description                                                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `useToolResult((toolName, result, tc) => {})`        | Fires once per completed tool call with parsed JSON result. Use for carts, scoreboards, etc. |
| `useToolResult<R>("tool_name", (result, tc) => {})`  | Fires only for the named tool, with `result` typed as `R`.                                   |

### Custom UI data flow

When a tool executes on the server, the result flows to the UI as follows:

```
Tool returns object on server
  → server sends "tool_call_start" (status: "pending", no result)
  → server sends "tool_call_done"  (status: "done", result as JSON string)
  → session.toolCalls signal updates
  → useToolResult fires callback with (toolName, parsedResult, toolCallInfo)
  → your component updates local state via useState
```

#### `useToolResult` in detail

```ts
useToolResult(callback: (toolName: string, result: unknown, toolCall: ToolCallInfo) => void): void
```

| Parameter  | Type             | Description                                                      |
| ---------- | ---------------- | ---------------------------------------------------------------- |
| `toolName` | `string`         | Name of the tool that completed                                  |
| `result`   | `unknown`        | **Parsed JSON** — the hook parses the raw JSON string for you. Falls back to the raw string if JSON parsing fails. |
| `toolCall` | `ToolCallInfo`   | Full metadata: `{ toolCallId, toolName, args, status, result, afterMessageIndex }` |

**When does it fire?** Exactly **once per completed tool call**. It tracks
`toolCallId` internally, so it never fires twice for the same call — even
when the `toolCalls` signal updates for unrelated reasons.

**What about multiple calls to the same tool?** Each call has a unique
`toolCallId`. If the agent calls `get_recipe` three times, your callback
fires three times — once for each call — with the individual result. Use
`toolCall.toolCallId` if you need to distinguish them, or `toolCall.args`
to see what arguments were passed.

**What does it return?** The `result` parameter is the **parsed JSON object**
your tool returned (not a string). For example, if your tool returns
`{ recipe: { name: "Pasta", steps: [...] } }`, the callback receives that
object directly. If the result isn't valid JSON, you get the raw string.

**Lifecycle:** When the session resets (user calls `reset()`), the internal
deduplication set clears, so tool calls from a new session are handled fresh.

#### `ToolCallInfo` type

```ts
type ToolCallInfo = {
  toolCallId: string;            // Unique ID — used for deduplication
  toolName: string;              // Tool name
  args: Record<string, unknown>; // Parsed arguments passed to the tool
  status: "pending" | "done";    // "pending" while executing, "done" when complete
  result?: string;               // Raw JSON string (only present when status="done")
  afterMessageIndex: number;     // Position in messages array for UI ordering
};
```

#### Simple example: recipe card

```tsx
import "aai-ui/styles.css";
import { useState } from "preact/hooks";
import { ChatView, mount, useSession, useToolResult } from "@alexkroman1/aai-ui";

interface Recipe { name: string; ingredients: string[]; steps: string[] }

function RecipeAgent() {
  const { session, started, start } = useSession();
  const [recipe, setRecipe] = useState<Recipe | null>(null);

  useToolResult((toolName, result: any) => {
    if (toolName === "get_recipe" && result.recipe) {
      setRecipe(result.recipe);
    }
  });

  if (!started.value) return <button onClick={start}>Start</button>;

  return (
    <div class="flex gap-4 h-full">
      <div class="flex-1"><ChatView /></div>
      {recipe && (
        <div class="w-80 p-4 bg-aai-surface rounded-lg">
          <h2 class="text-aai-text font-bold text-lg">{recipe.name}</h2>
          <h3 class="text-aai-muted mt-2 font-semibold">Ingredients</h3>
          <ul class="list-disc ml-4 text-aai-text text-sm">
            {recipe.ingredients.map((ing) => <li key={ing}>{ing}</li>)}
          </ul>
          <h3 class="text-aai-muted mt-2 font-semibold">Steps</h3>
          <ol class="list-decimal ml-4 text-aai-text text-sm">
            {recipe.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
        </div>
      )}
    </div>
  );
}

mount(RecipeAgent);
```

#### Handling multiple tool calls of the same name

If the agent calls `get_recipe` multiple times (e.g. user asks for a different
recipe), each call fires the callback separately. Store a list or replace the
previous value — whatever your UI needs:

```tsx
// Replace: always show the latest recipe
useToolResult((toolName, result: any) => {
  if (toolName === "get_recipe") setRecipe(result.recipe);
});

// Accumulate: collect all recipes
useToolResult((toolName, result: any) => {
  if (toolName === "get_recipe") {
    setRecipes((prev) => [...prev, result.recipe]);
  }
});
```

#### Anti-patterns

**Do NOT use `useEffect` + `session.toolCalls.value` to build derived state.**
That pattern re-processes every tool call on every signal change, causing
duplicates (e.g. items added to the cart multiple times). `useToolResult`
handles deduplication correctly.

```tsx
// ❌ WRONG — duplicates on every signal update
useEffect(() => {
  for (const tc of session.toolCalls.value) {
    if (tc.status === "done") setCart((prev) => [...prev, tc.result]);
  }
}, [session.toolCalls.value]);

// ✅ CORRECT — fires once per completed call
useToolResult((toolName, result) => {
  if (toolName === "add_item") setCart((prev) => [...prev, result.item]);
});
```

**Signal semantics for utterances:**

- `userUtterance`: `null` = user is not speaking, `""` = speech detected but
  no text yet (show "..."), non-empty string = partial/final transcript
- `agentUtterance`: `null` = agent is not speaking, non-empty string =
  streaming response text (cleared when final `chat` message arrives)
- `disconnected`: `null` = connected, `{ intentional: true }` = user
  disconnected, `{ intentional: false }` = unexpected disconnect (show
  reconnect UI)

**Message type:** `{ role: "user" | "assistant"; content: string }`.

### Showing tool calls in custom UI

```tsx
import "aai-ui/styles.css";
import { mount, ToolCallBlock, useSession } from "@alexkroman1/aai-ui";

function App() {
  const { session, started, start } = useSession();
  if (!started.value) return <button onClick={start}>Start</button>;

  const msgs = session.messages.value;
  const toolCalls = session.toolCalls.value;

  return (
    <div>
      {msgs.map((m, i) => (
        <div key={i}>
          <p>{m.content}</p>
          {toolCalls
            .filter((tc) => tc.afterMessageIndex === i)
            .map((tc) => <ToolCallBlock key={tc.toolCallId} toolCall={tc} />)}
        </div>
      ))}
    </div>
  );
}

mount(App);
```

### Building dynamic UI from tool results

Use `useToolResult` to update local state whenever a tool completes. See
the **Custom UI data flow** section above for the full reference, including
callback signature, `ToolCallInfo` type, and anti-patterns.

**Sharing types between agent and client:** Create a `shared.ts` file with
your tool result types using `ToolResultMap`, then import it from both
`agent.ts` and `client.tsx`:

```ts
// shared.ts — imported by both agent.ts and client.tsx
import type { ToolResultMap } from "@alexkroman1/aai";

export interface CartItem { id: number; name: string; price: number }

export type ShopToolResults = ToolResultMap<{
  add_item: { item: CartItem };
  remove_item: { removedId: number };
  clear_cart: { cleared: boolean };
}>;
```

```tsx
// client.tsx — typed tool results, no duplication
import "aai-ui/styles.css";
import { useState } from "preact/hooks";
import { ChatView, SidebarLayout, StartScreen, mount, useToolResult } from "@alexkroman1/aai-ui";
import type { CartItem, ShopToolResults } from "./shared.ts";

function ShopAgent() {
  const [cart, setCart] = useState<CartItem[]>([]);

  useToolResult<ShopToolResults["add_item"]>("add_item", (result) => {
    setCart((prev) => [...prev, result.item]);
  });
  useToolResult<ShopToolResults["remove_item"]>("remove_item", (result) => {
    setCart((prev) => prev.filter((i) => i.id !== result.removedId));
  });
  useToolResult("clear_cart", () => {
    setCart([]);
  });

  const sidebar = (
    <div class="p-4">
      <h3 class="text-aai-text font-bold">Cart ({cart.length})</h3>
      {cart.map((i) => <p key={i.id} class="text-aai-text text-sm">{i.name} — ${i.price}</p>)}
    </div>
  );

  return (
    <StartScreen title="Shop" buttonText="Start Shopping">
      <SidebarLayout sidebar={sidebar}>
        <ChatView />
      </SidebarLayout>
    </StartScreen>
  );
}

mount(ShopAgent);
```

### Reacting to agent state

```tsx
import "aai-ui/styles.css";
import { useEffect } from "preact/hooks";
import { mount, StateIndicator, useSession } from "@alexkroman1/aai-ui";

function App() {
  const { session, started, start } = useSession();

  useEffect(() => {
    // Run side effects when state changes
    if (session.state.value === "speaking") {
      // Agent is speaking — e.g., show animation
    }
  }, [session.state.value]);

  return (
    <div>
      <StateIndicator />
      {!started.value && <button onClick={start}>Start</button>}
    </div>
  );
}

mount(App);
```

### Styling custom UIs

The framework uses **Tailwind CSS v4** (compiled at bundle time). Prefer
Tailwind classes over inline styles — all design tokens work as classes:
`bg-aai-surface` not `style={{ background: "var(--color-aai-surface)" }}`,
`border-t border-aai-border` not `style={{ borderTop: "1px solid var(--)" }}`.

Three approaches:

1. **Tailwind classes** — `class="flex items-center gap-2 bg-aai-surface"`
2. **Inline styles** — only for dynamic values (`style={{ width: pixels }}`)
3. **Injected `<style>` tags** — for keyframes, selectors, media queries:

```tsx
function App() {
  return (
    <>
      <style>
        {`
        @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.5 } }
        .pulse { animation: pulse 2s ease-in-out infinite; }
        @media (max-width: 640px) { .sidebar { display: none; } }
      `}
      </style>
      <div class="pulse">Content</div>
    </>
  );
}
```

**Design tokens** — available as CSS custom properties and Tailwind classes
(e.g. `bg-aai-bg`, `text-aai-text-muted`, `rounded-aai`, `font-aai`):

| Token                        | Tailwind class            | Default                   |
| ---------------------------- | ------------------------- | ------------------------- |
| `--color-aai-bg`             | `bg-aai-bg`               | `#101010`                 |
| `--color-aai-surface`        | `bg-aai-surface`          | `#151515`                 |
| `--color-aai-surface-faint`  | `bg-aai-surface-faint`    | `rgba(255,255,255,0.031)` |
| `--color-aai-surface-hover`  | `bg-aai-surface-hover`    | `rgba(255,255,255,0.059)` |
| `--color-aai-border`         | `border-aai-border`       | `#282828`                 |
| `--color-aai-primary`        | `text-aai-primary`        | `#fab283`                 |
| `--color-aai-text`           | `text-aai-text`           | `rgba(255,255,255,0.936)` |
| `--color-aai-text-secondary` | `text-aai-text-secondary` | `rgba(255,255,255,0.618)` |
| `--color-aai-text-muted`     | `text-aai-text-muted`     | `rgba(255,255,255,0.284)` |
| `--color-aai-text-dim`       | `text-aai-text-dim`       | `rgba(255,255,255,0.422)` |
| `--color-aai-error`          | `text-aai-error`          | `#e06c75`                 |
| `--color-aai-ring`           | `ring-aai-ring`           | `#56b6c2`                 |
| `--color-aai-state-{state}`  | `text-aai-state-{state}`  | per-state colors          |
| `--radius-aai`               | `rounded-aai`             | `6px`                     |
| `--font-aai`                 | `font-aai`                | Inter, sans-serif         |
| `--font-aai-mono`            | `font-aai-mono`           | IBM Plex Mono, mono       |

The 5 core colors (`bg`, `primary`, `text`, `surface`, `border`) can be
overridden via `mount()` theme options. All other tokens use fixed defaults.

### Common UI patterns

**Auto-scrolling messages** — use `useAutoScroll` for custom message lists:

```tsx
import { useAutoScroll, useSession } from "@alexkroman1/aai-ui";

function MyChat() {
  const { session } = useSession();
  const bottomRef = useAutoScroll();

  return (
    <div class="overflow-y-auto">
      {session.messages.value.map((m, i) => <p key={i}>{m.content}</p>)}
      <div ref={bottomRef} />
    </div>
  );
}
```

Note: `MessageList` and `ChatView` already include auto-scroll. Only use
`useAutoScroll` when building a fully custom message list.

**Reading signal values in render:** Extract `.value` once at the top of the
component to avoid redundant signal subscriptions:

```tsx
function MyComponent() {
  const { session } = useSession();
  const state = session.state.value;
  const msgs = session.messages.value;
  // Use `state` and `msgs` as plain values throughout the render
}
```

## Self-hosting with `createServer()`

Agents can run anywhere (Node, Docker) without the managed platform:

```ts
import { defineAgent } from "@alexkroman1/aai";
import { createServer } from "@alexkroman1/aai/server";

const agent = defineAgent({
  name: "My Agent",
  instructions: "You are a helpful assistant.",
});

const server = createServer({
  agent,
  clientDir: "public", // optional: serve static files
});

await server.listen(3000);
```

Run with `node server.ts` (Node >=22.6 strips types natively) or bundle
with your preferred tool. The server handles WebSocket connections, STT/TTS,
and the agentic loop. Set `ASSEMBLYAI_API_KEY` as an environment variable.

## Useful free API endpoints

These public APIs require no auth and work well in voice agents:

```text
Weather (Open-Meteo):
  Geocode: https://geocoding-api.open-meteo.com/v1/search?name={city}&count=1&language=en
  Forecast: https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&timezone=auto&forecast_days=7

Currency (ExchangeRate):
  Rates: https://open.er-api.com/v6/latest/{CODE}  →  { rates: { USD: 1.0, EUR: 0.85, ... } }

Crypto (CoinGecko):
  Price: https://api.coingecko.com/api/v3/simple/price?ids={coin}&vs_currencies={cur}&include_24hr_change=true

Drug info (FDA):
  Label: https://api.fda.gov/drug/label.json?search=openfda.generic_name:"{name}"&limit=1

Drug interactions (RxNorm):
  RxCUI: https://rxnav.nlm.nih.gov/REST/rxcui.json?name={name}
  Interactions: https://rxnav.nlm.nih.gov/REST/interaction/list.json?rxcuis={id1}+{id2}
```

Use `fetch_json` builtin tool or `fetch` in custom tools to call these.

## Project structure

After scaffolding, your project directory looks like:

```text
my-agent/
  agent.ts          # Agent definition
  agent.test.ts     # Agent tests (vitest)
  client.tsx        # UI component (calls mount() to render into #app)
  styles.css        # Tailwind CSS entry point
  package.json      # Dependencies, scripts, and config
  tsconfig.json     # TypeScript configuration
  .env.example      # Reference for env var names
  .env              # Local dev secrets (gitignored)
  .gitignore        # Ignores node_modules/, .aai/, .env, etc.
  README.md         # Getting started guide
  CLAUDE.md         # Agent API reference (always loaded by Claude Code)
  .aai/             # Build output (managed by CLI, gitignored)
    project.json    # Deploy target (slug, server URL)
    build/          # Bundle output
```

## Testing agents

Test your agent's tools and conversation flows without audio, network, or an
LLM using the test harness from `@alexkroman1/aai/testing`.

```sh
pnpm test       # Run all tests (vitest)
```

### Setup

Tests live in `agent.test.ts` alongside `agent.ts`. The project includes
vitest as a dev dependency. Import the matchers for `expect().toHaveCalledTool()`:

### Test harness

```ts
import { describe, expect, test } from "vitest";
import { createTestHarness } from "@alexkroman1/aai/testing";
import "@alexkroman1/aai/testing/matchers";
import agent from "./agent.ts";

describe("my agent", () => {
  test("tool returns expected result", async () => {
    const t = createTestHarness(agent);
    const result = await t.executeTool("my_tool", { key: "value" });
    expect(result).toBe("expected");
  });
});
```

`createTestHarness(agent, options?)` wraps your agent and provides:

| Method / Property | Description |
| --- | --- |
| `executeTool(name, args)` | Execute a single tool with full agent context |
| `turn(text, toolCalls?)` | Simulate a user turn with optional tool calls |
| `addUserMessage(text)` | Add a user message to conversation history |
| `addAssistantMessage(text)` | Add an assistant message to history |
| `messages` | Read-only conversation history |
| `steps` | All `onStep` hook invocations recorded |
| `turns` | All `onTurn` hook invocations recorded |
| `connect()` / `disconnect()` | Fire lifecycle hooks manually |
| `reset()` | Clear conversation state |

Options:

```ts
createTestHarness(agent, {
  env: { API_KEY: "test-key" },  // mock environment variables
  kv: myKvStore,                  // custom KV store (default: in-memory)
  vector: myVectorStore,          // custom vector store (default: in-memory)
});
```

### Simulating turns with tool calls

```ts
test("multi-turn pizza ordering", async () => {
  const t = createTestHarness(agent);

  const turn1 = await t.turn("I want a large pepperoni", [
    { tool: "add_pizza", args: { size: "large", crust: "regular", toppings: ["pepperoni"], quantity: 1 } },
  ]);

  // Vitest custom matchers — natural expect() syntax
  expect(turn1).toHaveCalledTool("add_pizza");
  expect(turn1).toHaveCalledTool("add_pizza", { size: "large" }); // partial match
  expect(turn1).not.toHaveCalledTool("remove_pizza");

  // Typed tool results — no JSON.parse needed
  const result = turn1.toolResult<{ added: { size: string }; orderTotal: string }>("add_pizza");
  expect(result.orderTotal).toContain("$14.99");

  // State persists across turns
  const turn2 = await t.turn("Show my order", [
    { tool: "view_order", args: {} },
  ]);
  const order = turn2.toolResult<{ pizzas: unknown[] }>("view_order");
  expect(order.pizzas).toHaveLength(1);
});
```

### TurnResult API

| Method / Property | Description |
| --- | --- |
| `toolResult<T>(name)` | Get parsed JSON result of first call to named tool |
| `getToolCalls(name)` | Get all calls to a specific tool |
| `toolCalls` | All recorded tool calls with name, args, result |
| `toolResults` | Just the result strings from each tool call |
| `text` | The user text that initiated this turn |

Vitest custom matchers (import `@alexkroman1/aai/testing/matchers`):

| Matcher | Description |
| --- | --- |
| `expect(turn).toHaveCalledTool(name)` | Assert tool was called |
| `expect(turn).toHaveCalledTool(name, args)` | Assert with partial args |
| `expect(turn).not.toHaveCalledTool(name)` | Assert tool was NOT called |

### Testing patterns

**Environment variables:**

```ts
const t = createTestHarness(agent, { env: { MY_KEY: "test-123" } });
const result = await t.executeTool("check_key", {});
expect(result).toBe("test-123");
```

**State persistence across turns:**

```ts
const t = createTestHarness(agent);
await t.turn("first action", [{ tool: "increment", args: {} }]);
await t.turn("second action", [{ tool: "increment", args: {} }]);
const turn = await t.turn("check", [{ tool: "get_count", args: {} }]);
expect(turn.toolResults[0]).toBe("2");
```

**Pre-loading conversation history:**

```ts
const t = createTestHarness(agent);
t.addUserMessage("My name is Alice");
t.addAssistantMessage("Nice to meet you, Alice.");
const turn = await t.turn("What is my name?", [
  { tool: "recall", args: {} },
]);
// Tool has access to full message history via ctx.messages
```

## Common pitfalls

- **Using `useEffect` to build state from tool calls** — Use `useToolResult`
  instead. It fires once per completed tool call with deduplication. Iterating
  `session.toolCalls.value` in `useEffect` causes duplicates.
- **Visual formatting in `instructions`** — Bullets, bold, numbered lists sound
  terrible when spoken. Use "First", "Next", "Finally" transitions instead.
- **Returning huge payloads from tools** — Tool returns go into LLM context.
  Filter and truncate API responses to only what the agent needs.
- **Verbose instructions** — Voice responses should be 1-3 sentences. Don't
  say "provide detailed explanations" — the agent will monologue.
- **Hardcoding secrets** — Use `aai secret put` + `ctx.env`, never inline keys.
  Set secrets before deploying.
- **SSRF restrictions** — `fetch` is proxied; private/internal IPs (localhost,
  10.x, 192.168.x) are blocked.

## Troubleshooting

- **"no agent found"** — Ensure `agent.ts` exists in the current directory
- **"bundle failed"** — TypeScript syntax error — check imports, brackets
- **"No .aai/project.json found"** — Run `aai deploy` first before using
  `aai secret`
- **Tool returns `undefined`** — Make sure `execute` returns a value. Even
  `return { ok: true }` is better than an implicit void return.
- **Agent doesn't use a tool** — Check `description` is clear about when to use
  it. The LLM relies on the description to decide. Also check `activeTools`
  isn't filtering it out.
- **KV reads return `null`** — Keys are scoped per agent deployment. A
  redeployment with a new slug creates a fresh KV namespace.
