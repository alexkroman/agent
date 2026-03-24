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
- Custom UI goes in `client.tsx` alongside `agent.ts`
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
aai build                # Bundle and validate (no server or deploy)
aai deploy               # Bundle and deploy to production
aai deploy -y            # Deploy without prompts
aai deploy --dry-run     # Validate and bundle without deploying
aai secret put <NAME>    # Set a secret on the server (prompts for value)
aai secret delete <NAME> # Remove a secret
aai secret list          # List secret names
aai secret pull          # Pull secret names into .env for local dev
aai rag <url>            # Ingest a site's llms-full.txt into the vector store
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
| `embedded-assets`   | FAQ bot using embedded JSON knowledge (no web search)                              |
| `support`           | RAG-powered support agent using vector_search (AssemblyAI docs example)            |

## Minimal agent

Every agent lives in `agent.ts` and exports a default `defineAgent()` call:

```ts
import { defineAgent } from "aai";

export default defineAgent({
  name: "My Agent",
  instructions: "You are a helpful assistant that...",
  greeting: "Hey there. What can I help you with?",
});
```

### Imports

```ts
import { defineAgent, tool } from "aai"; // defineAgent + helpers
import type { BeforeStepResult, BuiltinTool, HookContext, StepInfo, ToolContext } from "aai";
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

### Environment variables

Secrets are managed on the server via the CLI, like `vercel env`. They are
injected into agent workers at runtime and available as `ctx.env`. Secrets are
**never** embedded in the bundled code.

```sh
# Set secrets on the server (prompts for value)
aai secret put ASSEMBLYAI_API_KEY
aai secret put MY_API_KEY

# List what's set
aai secret list

# Pull secret names into .env for local dev reference
aai secret pull

# Remove a secret
aai secret delete MY_API_KEY
```

Access secrets in tool code via `ctx.env`:

```ts
import { defineAgent } from "aai";
import { z } from "zod";

export default defineAgent({
  name: "API Agent",
  tools: {
    call_api: {
      description: "Call an external API",
      parameters: z.object({ query: z.string() }),
      execute: async (args, ctx) => {
        const res = await fetch(`https://api.example.com?q=${args.query}`, {
          headers: { Authorization: `Bearer ${ctx.env.MY_API_KEY}` },
        });
        return res.json();
      },
    },
  },
});
```

## Tools

### Custom tools

Define tools as plain objects in the `tools` record. The `parameters` field
takes a Zod schema for type-safe argument inference:

```ts
import { defineAgent, tool } from "aai";
import { z } from "zod";

export default defineAgent({
  name: "Weather Agent",
  tools: {
    get_weather: tool({
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

    // No-parameter tools — omit `parameters` and `tool()` wrapper
    list_items: {
      description: "List all items",
      execute: () => items,
    },
  },
});
```

**Important:** Wrap tool definitions in `tool()` to get typed `args` inferred
from the Zod `parameters` schema. Without `tool()`, args are untyped.

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
| `visit_webpage` | Fetch URL → Markdown                           | `url`                               |
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

Use `fetch` directly in tool execute functions:

```ts
execute: async (args, ctx) => {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${ctx.env.API_KEY}` },
  });
  if (!resp.ok) return { error: `${resp.status} ${resp.statusText}` };
  return resp.json();
},
```

`fetch` is proxied through the host process (the worker has no direct network
access). All URLs are validated against SSRF rules — only public addresses are
allowed.

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
await ctx.kv.delete("user:123"); // delete
```

Keys are strings; use colon-separated prefixes (`"user:123"`). Max value: 64 KB.

`kv.list()` returns `KvEntry[]` where each entry has
`{ key: string, value: T }`.

### Memory tools (pre-built KV tools)

Add `"memory"` to `builtinTools` to give the agent four persistent KV tools:
`save_memory`, `recall_memory`, `list_memories`, and `forget_memory`.

```ts
import { defineAgent } from "aai";

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

### Dynamic `maxSteps`

```ts
maxSteps: (ctx) => {
  const state = ctx.state as { complexity: string };
  return state.complexity === "complex" ? 10 : 5;
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

## Custom UI (`client.tsx`)

Add `client.tsx` alongside `agent.ts`. Define a Preact component and call
`mount()` to render it. Use JSX syntax:

```tsx
import "aai-ui/styles.css";
import { mount, useSession } from "aai-ui";

function App() {
  const { session, started, running, start, toggle, reset } = useSession();
  const msgs = session.messages.value;
  const tx = session.userUtterance.value;
  return (
    <div>
      {msgs.map((m, i) => <p key={i}>{m.text}</p>)}
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
| `session.messages.value`       | `Message[]`            | `{ role, text }` objects                                        |
| `session.toolCalls.value`      | `ToolCallInfo[]`       | `{ toolCallId, toolName, args, status, result? }` — tool calls  |
| `session.userUtterance.value`  | `string \| null`       | `null` = not speaking, `""` = speech detected, string = text    |
| `session.agentUtterance.value` | `string \| null`       | `null` = not speaking, string = streaming agent response text   |
| `session.error.value`          | `SessionError \| null` | `{ code, message }`                                             |
| `session.disconnected.value`   | `object \| null`       | `{ intentional: boolean }` when disconnected, `null` otherwise  |
| `started.value`                | `boolean`              | Whether session has been started                                |
| `running.value`                | `boolean`              | Whether session is active                                       |

**Methods:** `start()`, `toggle()`, `reset()`, `dispose()`

**Hooks:**

| Hook                                          | Description                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `useToolResult((toolName, result, tc) => {})` | Fires once per completed tool call with parsed JSON result. Use for carts, scoreboards, etc. |

**Signal semantics for utterances:**

- `userUtterance`: `null` = user is not speaking, `""` = speech detected but
  no text yet (show "..."), non-empty string = partial/final transcript
- `agentUtterance`: `null` = agent is not speaking, non-empty string =
  streaming response text (cleared when final `chat` message arrives)
- `disconnected`: `null` = connected, `{ intentional: true }` = user
  disconnected, `{ intentional: false }` = unexpected disconnect (show
  reconnect UI)

**UI Message type:** `{ role: "user" | "assistant"; text: string }`. Note: UI
messages use `text` (not `content`). The SDK `Message` type uses `content` — do
not mix them up in custom UIs.

### Showing tool calls in custom UI

```tsx
import "aai-ui/styles.css";
import { mount, ToolCallBlock, useSession } from "aai-ui";

function App() {
  const { session, started, start } = useSession();
  if (!started.value) return <button onClick={start}>Start</button>;

  const msgs = session.messages.value;
  const toolCalls = session.toolCalls.value;

  return (
    <div>
      {msgs.map((m, i) => (
        <div key={i}>
          <p>{m.text}</p>
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

Use `useToolResult` to update local state (carts, scoreboards, dashboards)
whenever a tool completes. It fires exactly once per completed tool call with
the parsed JSON result, handling deduplication internally.

```tsx
import "aai-ui/styles.css";
import { useState } from "preact/hooks";
import { ChatView, SidebarLayout, StartScreen, mount, useToolResult } from "aai-ui";

interface CartItem { id: number; name: string; price: number }

function ShopAgent() {
  const [cart, setCart] = useState<CartItem[]>([]);

  useToolResult((toolName, result: any) => {
    switch (toolName) {
      case "add_item":
        setCart((prev) => [...prev, result.item]);
        break;
      case "remove_item":
        setCart((prev) => prev.filter((i) => i.id !== result.removedId));
        break;
      case "clear_cart":
        setCart([]);
        break;
    }
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

**Do NOT use `useEffect` + `session.toolCalls.value` to build derived state.**
That pattern re-processes every tool call on every signal change, causing
duplicates (e.g. items added to the cart multiple times). `useToolResult`
handles this correctly.

### Reacting to agent state

```tsx
import "aai-ui/styles.css";
import { useEffect } from "preact/hooks";
import { mount, StateIndicator, useSession } from "aai-ui";

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
import { useAutoScroll, useSession } from "aai-ui";

function MyChat() {
  const { session } = useSession();
  const bottomRef = useAutoScroll();

  return (
    <div class="overflow-y-auto">
      {session.messages.value.map((m, i) => <p key={i}>{m.text}</p>)}
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

Agents can run anywhere (Node, Deno, Docker) without the managed platform:

```ts
import { defineAgent } from "aai";
import { createServer } from "aai/server";

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

Run with `node --experimental-strip-types server.ts` or bundle with your
preferred tool. The server handles WebSocket connections, STT/TTS, and the
agentic loop. Set `ASSEMBLYAI_API_KEY` as an environment variable.

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

## Custom start screen with `StartScreen`

Use `StartScreen` for a branded start card that transitions to `ChatView`:

```tsx
import "aai-ui/styles.css";
import { ChatView, StartScreen, mount } from "aai-ui";

function MyAgent() {
  return (
    <StartScreen icon={<span>&#x1F3A4;</span>} title="My Agent" subtitle="Ask me anything">
      <ChatView />
    </StartScreen>
  );
}

mount(MyAgent);
```

`StartScreen` handles the started/not-started transition automatically. Pass
`icon`, `title`, `subtitle`, and `buttonText` to customize the card.

## Sidebar layout with `SidebarLayout`

Use `SidebarLayout` for apps with a persistent side panel (cart, dashboard):

```tsx
import "aai-ui/styles.css";
import { useState } from "preact/hooks";
import { ChatView, SidebarLayout, StartScreen, mount, useToolResult } from "aai-ui";

function ShopAgent() {
  const [cart, setCart] = useState<{ id: number; name: string }[]>([]);

  useToolResult((toolName, result: any) => {
    if (toolName === "add_item") setCart((prev) => [...prev, result.item]);
  });

  const sidebar = (
    <div class="p-4">
      <h3 class="text-aai-text font-bold">Cart ({cart.length})</h3>
      {cart.map((i) => <p key={i.id} class="text-aai-text text-sm">{i.name}</p>)}
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

`SidebarLayout` accepts `width` (default `"20rem"`) and `side` (`"left"` or
`"right"`).

## Project structure

After scaffolding, your project directory looks like:

```text
my-agent/
  agent.ts          # Agent definition
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

## Instructions patterns from templates

Good instructions tell the LLM what it is, how to behave, and when to use each
tool. Study these patterns:

**Code execution agent** — force tool use for anything computational:

```text
You MUST use the run_code tool for ANY question involving math, counting,
string manipulation, or data processing. NEVER do mental math or estimate.
Use console.log() to output intermediate steps.
```

**Research agent** — search before answering:

```text
Search first. Never guess or rely on memory for factual questions.
Use visit_webpage when search snippets aren't detailed enough.
For complex questions, search multiple times with different queries.
```

**FAQ/support agent** — stay grounded in knowledge:

```text
Always use vector_search to find relevant documentation before answering.
Base your answers strictly on the retrieved documentation — don't guess.
If search results aren't relevant, say the docs don't cover that topic.
```

**API-calling agent** — tell the LLM which endpoints to use:

```text
API endpoints (use fetch_json):
- Currency rates: https://open.er-api.com/v6/latest/{CODE}
  Returns { rates: { USD: 1.0, EUR: 0.85, ... } }
- Weather: https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}...
```

**Game/interactive agent** — establish world rules and voice style:

```text
You ARE the game. Maintain world state, describe rooms, handle puzzles.
Keep descriptions to two to four sentences. No visual formatting.
Use directional words naturally: "To the north you see..." not "N: forest"
```

## Common pitfalls

- **Using `useEffect` to build state from tool calls** — Iterating
  `session.toolCalls.value` in a `useEffect` re-processes every tool call on
  every signal change, causing duplicates (e.g. cart items added multiple
  times). Use the `useToolResult` hook instead — it fires exactly once per
  completed tool call with proper deduplication.
- **Writing `instructions` with visual formatting** — Bullets, bold, numbered
  lists sound terrible when spoken. Use natural transitions: "First", "Next",
  "Finally". Write instructions as if you're coaching a human phone operator.
- **Returning huge payloads from tools** — Everything a tool returns goes into
  the LLM context. Filter, summarize, or truncate API responses before
  returning. Return only what the agent needs to formulate a spoken answer.
- **Forgetting sandbox constraints** — Agent code runs in a sandboxed Worker
  with no direct network or filesystem access. Use `fetch` (proxied through the
  host) for HTTP. Use `ctx.env` for secrets. Direct network access will fail.
- **Hardcoding secrets** — Never put API keys in `agent.ts`. Use
  `aai secret put MY_KEY` to store them on the server, then access via
  `ctx.env.MY_KEY`.
- **Telling the agent to be verbose** — Voice responses should be 1-3 sentences.
  If your `instructions` say "provide detailed explanations", the agent will
  monologue. Instruct it to be brief and let the user ask follow-ups.
- **Not setting secrets before deploying** — If your agent needs custom
  secrets, set them with `aai secret put MY_KEY` before deploying.
- **Forgetting SSRF restrictions on `fetch`** — The host validates all proxied
  fetch URLs. Requests to private/internal IP addresses (localhost, 10.x,
  192.168.x, etc.) are blocked.

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
