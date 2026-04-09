# aai Voice Agent Project

You are helping a user build a voice agent using the **aai** framework.

## Workflow

1. **Understand** -- Restate what the user wants to build. If the request is
   vague, ask a clarifying question before writing code.
2. **Check existing work** -- Look for a template or built-in tool that already
   does what the user needs before writing custom code.
3. **Start minimal** -- Scaffold from the closest template, then layer on
   customizations. Don't over-engineer the first version.
4. **Verify** -- After every change, run `aai build` to validate the bundle and
   catch errors. Fix all errors before presenting work to the user.
5. **Iterate** -- Make small, focused changes. Verify each change works before
   moving on.

## Key rules

- Every agent is a **directory** with `agent.json` + optional `tools/*.ts` +
  `hooks/*.ts` + `client.tsx`
- No SDK imports needed for agent code -- tools and hooks are plain TypeScript
  files
- Custom UI goes in `client.tsx` alongside `agent.json` -- **uses Preact, not
  React** (import from `preact/hooks`, not `react`)
- Optimize `systemPrompt` for spoken conversation -- short sentences, no visual
  formatting, no exclamation points
- Never hardcode secrets -- use `aai secret put` and access via `ctx.env`
- Tool `execute` return values go into LLM context -- filter and truncate large
  API responses
- Agent code runs in a sandboxed worker -- use `fetch` (proxied) for HTTP,
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
aai delete               # Remove a deployed agent
aai secret put <NAME>    # Set a secret on the server (prompts for value)
aai secret delete <NAME> # Remove a secret
aai secret list          # List secret names
```

## Templates

Before writing an agent from scratch, choose the closest template and scaffold
with `aai init -t <template_name>`.

**Starter / utility:**

| Template          | Description                                                                        |
| ----------------- | ---------------------------------------------------------------------------------- |
| `simple`          | Minimal starter with web_search, visit_webpage, fetch_json, run_code. **Default.** |
| `embedded-assets` | FAQ bot using embedded JSON knowledge (no web search)                              |
| `test-patterns`   | Demonstrates every testable agent pattern (tools, hooks, state)                    |

**Research / knowledge:**

| Template         | Description                                                          |
| ---------------- | -------------------------------------------------------------------- |
| `web-researcher` | Research assistant -- web search + page visits for detailed answers  |
| `smart-research` | Phase-based research (gather, analyze, respond) with dynamic tools   |
| `support`        | Support agent for AssemblyAI docs                                    |

**Tools / computation:**

| Template           | Description                                                |
| ------------------ | ---------------------------------------------------------- |
| `code-interpreter` | Writes and runs JavaScript for math, calculations, data    |
| `math-buddy`       | Calculations, unit conversions, dice rolls via run_code    |

**Domain-specific:**

| Template           | Description                                                   |
| ------------------ | ------------------------------------------------------------- |
| `health-assistant` | Medication lookup, drug interactions, BMI, symptom guidance   |
| `personal-finance` | Currency conversion, crypto prices, loan calculations         |
| `travel-concierge` | Trip planning, weather, flights, hotels, currency conversion  |

**Custom UI examples** (include `client.tsx`):

| Template            | Description                                                |
| ------------------- | ---------------------------------------------------------- |
| `night-owl`         | Movie/music/book recs by mood, sleep calculator            |
| `pizza-ordering`    | Pizza order-taker with dynamic cart sidebar                |
| `dispatch-center`   | 911 dispatch with incident triage and resource assignment  |
| `infocom-adventure` | Zork-style text adventure with state, puzzles, inventory   |
| `solo-rpg`          | Solo dark-fantasy RPG with dice, oaths, combat, save/load  |

## Directory structure

Every agent is a directory containing `agent.json` and optional subdirectories:

```text
my-agent/
  agent.json          # Agent configuration (required)
  system-prompt.md    # Long system prompt (optional, referenced via $ref)
  tools/              # Custom tools -- one .ts file per tool
    get_weather.ts
    search_faq.ts
  hooks/              # Lifecycle hooks -- one .ts file per hook
    on-connect.ts
    on-user-transcript.ts
  client.tsx          # Custom UI (optional, uses Preact)
  agent.test.ts       # Agent tests (vitest)
  styles.css          # Tailwind CSS entry point
  package.json        # Dependencies, scripts, and config
  tsconfig.json       # TypeScript configuration
  .env.example        # Reference for env var names
  .env                # Local dev secrets (gitignored)
  .gitignore          # Ignores node_modules/, .aai/, .env, etc.
  README.md           # Getting started guide
  CLAUDE.md           # Agent API reference (always loaded by Claude Code)
  .aai/               # Build output (managed by CLI, gitignored)
    project.json      # Deploy target (slug, server URL)
    build/            # Bundle output
```

## Minimal agent

The simplest agent is just an `agent.json` file:

```json
{
  "name": "My Agent"
}
```

No imports needed. No build step for the configuration.

## `agent.json` format

```json
{
  "name": "My Agent",
  "systemPrompt": "You are a helpful assistant that...",
  "greeting": "Hey there. What can I help you with?",
  "sttPrompt": "Transcribe technical terms: Kubernetes, gRPC, PostgreSQL",
  "builtinTools": ["web_search", "visit_webpage", "fetch_json", "run_code"],
  "maxSteps": 5,
  "toolChoice": "auto",
  "idleTimeoutMs": 120000,
  "theme": {
    "bg": "#101010",
    "primary": "#fab283",
    "text": "#ffffff",
    "surface": "#1a1a1a",
    "border": "#333333"
  }
}
```

| Field           | Type       | Required | Default                    | Description                                              |
| --------------- | ---------- | -------- | -------------------------- | -------------------------------------------------------- |
| `name`          | `string`   | Yes      | --                         | Display name for the agent                               |
| `systemPrompt`  | `string`   | No       | General voice assistant    | System prompt sent to the LLM                            |
| `greeting`      | `string`   | No       | "Hey, how can I help you?" | Spoken when a user connects                              |
| `sttPrompt`     | `string`   | No       | --                         | STT guidance for jargon, names, acronyms                 |
| `builtinTools`  | `string[]` | No       | `[]`                       | Built-in tools to enable                                 |
| `maxSteps`      | `number`   | No       | `5`                        | Max tool calls per turn before forcing a response        |
| `toolChoice`    | `string`   | No       | `"auto"`                   | `"auto"` or `"required"`                                 |
| `idleTimeoutMs` | `number`   | No       | --                         | Disconnect after this many ms of inactivity              |
| `theme`         | `object`   | No       | --                         | CSS color overrides (bg, primary, text, surface, border) |

### systemPrompt `$ref`

For long prompts, put the text in a separate file and reference it:

```json
{
  "name": "My Agent",
  "systemPrompt": { "$ref": "system-prompt.md" }
}
```

The CLI resolves the `$ref` at build time, reading the file contents into
the manifest.

### Writing good `systemPrompt`

Optimize for spoken conversation:

- Short, punchy sentences -- optimize for speech, not text
- Never mention "search results" or "sources" -- speak as if knowledge is your
  own
- No visual formatting ("bullet point", "bold") -- use "First", "Next",
  "Finally"
- Lead with the most important information
- Be concise and confident -- no hedging ("It seems that", "I believe")
- No exclamation points -- calm, conversational tone
- Define personality, tone, and specialty
- Include when and how to use each tool

**Patterns by agent type:**

- **Code execution** -- "You MUST use the run_code tool for ANY question
  involving math, counting, or data processing. NEVER do mental math."
- **Research** -- "Search first. Never guess or rely on memory for factual
  questions. Use visit_webpage when search snippets aren't detailed enough."
- **FAQ/support** -- "Base answers strictly on your knowledge -- don't guess."
- **API-calling** -- List endpoints directly in systemPrompt so the LLM knows
  what's available and what each returns.
- **Game/interactive** -- "You ARE the game. Keep descriptions to two to four
  sentences. No visual formatting."

### Secrets / environment variables

Never hardcode secrets in agent code. Access them at runtime via `ctx.env`.

`ctx.env` contains **only** the secrets you explicitly declare -- not all of
`process.env`. This keeps behavior consistent between local dev and production.

**Local development** -- add secrets to `.env` in your project root. Only keys
listed here are available via `ctx.env` (shell exports override `.env` values):

```sh
# .env (gitignored)
ALPHA_VANTAGE_KEY=sk-abc123
MY_API_KEY=secret-value
```

**Production** -- set the same keys on the deployed server:

```sh
aai secret put MY_API_KEY    # Set (prompts for value)
aai secret list              # List names
aai secret delete MY_API_KEY # Remove
```

Access in tool code: `ctx.env.MY_API_KEY` (see "Fetching external APIs" below).

## Tools

### Custom tools

Each tool is a separate `.ts` file in the `tools/` directory. The filename
(minus `.ts`) becomes the tool name. A tool file exports:

1. `description` (required) -- a string the LLM uses to decide when to call it
2. `parameters` (optional) -- a JSON Schema object describing the arguments
3. `default` (required) -- the execute function

```ts
// tools/get_weather.ts
export const description = "Get current weather for a city";

export const parameters = {
  type: "object",
  properties: {
    city: { type: "string", description: "City name" },
  },
  required: ["city"],
};

export default async function execute(
  args: { city: string },
  ctx: { env: Record<string, string> },
) {
  const resp = await fetch(
    `https://api.example.com/weather?q=${args.city}&key=${ctx.env.WEATHER_KEY}`,
  );
  return resp.json();
}
```

**No-parameter tools** -- omit the `parameters` export:

```ts
// tools/list_items.ts
export const description = "List all available items";

export default async function execute() {
  return ["apple", "banana", "cherry"];
}
```

**JSON Schema patterns for `parameters`:**

```ts
export const parameters = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query" },
    category: { type: "string", enum: ["a", "b", "c"] },
    count: { type: "number", description: "How many" },
    label: { type: "string", description: "Optional label" },
  },
  required: ["query", "category", "count"],
};
```

### Built-in tools

Enable via `builtinTools` in `agent.json`.

| Tool            | Description                                    | Params                              |
| --------------- | ---------------------------------------------- | ----------------------------------- |
| `web_search`    | Search the web (Brave Search)                  | `query`, `max_results?` (default 5) |
| `visit_webpage` | Fetch URL to plain text                        | `url`                               |
| `fetch_json`    | HTTP GET a JSON API                            | `url`, `headers?`                   |
| `run_code`      | Execute JS in sandbox (no net/fs, 5s timeout)  | `code`                              |

The agentic loop runs up to `maxSteps` iterations (default 5) and stops when
the LLM produces a text response.

### Tool context

Every tool `execute` function receives `(args, ctx)`. The context object
provides:

```ts
ctx.env;       // Record<string, string> -- secrets (.env locally, aai secret put in production)
ctx.kv;        // persistent KV store (see KV section below)
ctx.messages;  // readonly Message[] -- conversation history
ctx.sessionId; // string -- unique session identifier
```

Type the context inline -- no SDK imports needed:

```ts
export default async function execute(
  args: { query: string },
  ctx: {
    env: Record<string, string>;
    kv: {
      get: <T>(key: string) => Promise<T | null>;
      set: (key: string, value: unknown, opts?: { expireIn: number }) => Promise<void>;
      delete: (key: string) => Promise<void>;
    };
    messages: { role: string; content: string }[];
    sessionId: string;
  },
) {
  // ...
}
```

**Timeouts:** Tool execution times out after **30 seconds**. Lifecycle hooks
(`onConnect`, `onUserTranscript`, etc.) time out after **5 seconds**.

### Fetching external APIs

Use `fetch` in tool execute functions. Access secrets via `ctx.env`:

```ts
export default async function execute(
  args: { query: string },
  ctx: { env: Record<string, string> },
) {
  const resp = await fetch(`https://api.example.com?q=${args.query}`, {
    headers: { Authorization: `Bearer ${ctx.env.MY_API_KEY}` },
  });
  if (!resp.ok) return { error: `${resp.status} ${resp.statusText}` };
  return resp.json();
}
```

`fetch` is proxied through the host -- the worker has no direct network access.
Only public URLs are allowed (private/internal IPs are blocked by SSRF rules).

## Hooks

Lifecycle hooks are `.ts` files in the `hooks/` directory. Each file exports
a `default` function.

| Filename                  | Fires when                        | Signature                                  |
| ------------------------- | --------------------------------- | ------------------------------------------ |
| `on-connect.ts`           | User connects                     | `(ctx) => void \| Promise<void>`           |
| `on-disconnect.ts`        | User disconnects                  | `(ctx) => void \| Promise<void>`           |
| `on-user-transcript.ts`   | STT produces a transcript         | `(text, ctx) => void \| Promise<void>`     |
| `on-error.ts`             | An error occurs                   | `(error, ctx?) => void`                    |

Hook context is the same as tool context but without `messages`.

Example -- save state on every user turn:

```ts
// hooks/on-user-transcript.ts
export default async function onUserTranscript(
  _text: string,
  ctx: {
    kv: {
      get: <T>(key: string) => Promise<T | null>;
      set: (key: string, value: unknown) => Promise<void>;
    };
  },
) {
  const count = (await ctx.kv.get<number>("turn-count")) ?? 0;
  await ctx.kv.set("turn-count", count + 1);
}
```

Example -- initialize data on connect:

```ts
// hooks/on-connect.ts
export default async function onConnect(ctx: {
  kv: { set: (key: string, value: unknown) => Promise<void> };
}) {
  await ctx.kv.set("owner", "connected-user");
}
```

## Persistent storage (KV)

`ctx.kv` is a persistent key-value store scoped per agent. Values are
auto-serialized as JSON.

```ts
await ctx.kv.set("user:123", { name: "Alice" });               // save
await ctx.kv.set("temp:x", value, { expireIn: 60_000 });       // save with TTL (ms)
const user = await ctx.kv.get<User>("user:123");                // read (or null)
await ctx.kv.delete("user:123");                                // delete
```

| Method                                    | Description                            |
| ----------------------------------------- | -------------------------------------- |
| `get<T>(key: string)`                     | Read a value (returns `T \| null`)     |
| `set(key, value, opts?: { expireIn? })`   | Write a value, optional TTL in ms      |
| `delete(key: string)`                     | Delete a key                           |

Keys are strings; use colon-separated prefixes (`"user:123"`). Max value: 64 KB.

To enumerate keys, maintain your own index key (e.g. store an array of IDs
under a known key and update it when you add or remove entries).

### Persisting state across reconnects

Use KV in hooks to auto-save and auto-load state:

```ts
// hooks/on-connect.ts
export default async function onConnect(ctx: {
  kv: { get: <T>(key: string) => Promise<T | null> };
}) {
  const saved = await ctx.kv.get("save:game");
  if (saved) {
    // Restore state -- tools can read it back from KV
  }
}
```

```ts
// hooks/on-user-transcript.ts
export default async function onUserTranscript(
  _text: string,
  ctx: { kv: { set: (key: string, value: unknown) => Promise<void> } },
) {
  // Auto-save after every user turn
  await ctx.kv.set("save:game", { score: 42 });
}
```

This works for games, workflows, or any agent where users expect to resume
where they left off.

## Advanced patterns

### Tool choice

Control when the LLM uses tools via `toolChoice` in `agent.json`:

- `"auto"` (default) -- LLM decides when to use tools
- `"required"` -- Force a tool call every step (useful for research pipelines)

### `maxSteps` -- controlling the agentic loop

The `maxSteps` option in `agent.json` limits how many tool calls the LLM can
make in a single turn before being forced to respond. Default is **5**.

**Choosing a value:** Count the maximum number of sequential tool calls your
agent needs in its longest workflow. For example, if a health-check workflow
calls `check_status`, `query_metrics`, `acknowledge_alert` -- that's 3 steps.
Add a small buffer (1-2) for the LLM to self-correct or call an extra tool,
giving `maxSteps: 5`. Multi-tool workflows that chain 5+ calls may need 8-10.

### Conversation history in tools

```ts
// tools/count_messages.ts
export const description = "Count conversation messages by role";

export default async function execute(
  _args: unknown,
  ctx: { messages: { role: string }[] },
) {
  const byRole: Record<string, number> = {};
  for (const msg of ctx.messages) {
    byRole[msg.role] = (byRole[msg.role] ?? 0) + 1;
  }
  return { total: ctx.messages.length, byRole };
}
```

### Embedded knowledge

Import JSON data directly in a tool file:

```ts
// tools/search_faq.ts
import knowledge from "../knowledge.json" with { type: "json" };

export const description = "Search the knowledge base";

export const parameters = {
  type: "object",
  properties: {
    query: { type: "string" },
  },
  required: ["query"],
};

export default async function execute(args: { query: string }) {
  return knowledge.faqs.filter((f: { question: string }) =>
    f.question.toLowerCase().includes(args.query.toLowerCase()),
  );
}
```

### Adding packages

Add packages to `package.json` dependencies:

```sh
pnpm add some-package
```

## Custom UI (`client.tsx`)

> **Important:** The client UI uses **Preact**, not React. Import hooks from
> `preact/hooks` (e.g. `import { useState } from "preact/hooks"`), not from
> `"react"`. Importing from `"react"` will cause bundler errors.

Add `client.tsx` alongside `agent.json`. Define a Preact component and call
`defineClient()` to render it. Use JSX syntax:

```tsx
import "aai-ui/styles.css";
import { defineClient, useSession } from "@alexkroman1/aai-ui";

function App() {
  const session = useSession();
  const msgs = session.messages.value;
  const tx = session.userUtterance.value;
  return (
    <div>
      {msgs.map((m, i) => <p key={i}>{m.content}</p>)}
      {tx !== null && <p>{tx || "..."}</p>}
      {!session.started.value ? <button onClick={() => session.start()}>Start</button> : (
        <>
          <button onClick={() => session.toggle()}>{session.running.value ? "Stop" : "Resume"}</button>
          <button onClick={() => session.reset()}>Reset</button>
        </>
      )}
    </div>
  );
}

defineClient(App);
```

**Rules:**

- Always import `"aai-ui/styles.css"` at the top -- without it, default styles
  won't load
- Call `defineClient(YourComponent)` at the end of the file
- Use `.tsx` file extension for JSX syntax
- Import hooks from `preact/hooks` (`useEffect`, `useRef`, `useState`, etc.)
- Style with Tailwind classes (`class="bg-aai-surface text-aai-text"`),
  inline styles for dynamic values, or injected `<style>` tags for keyframes
  and media queries
- Do **not** add a `tailwind.config.js` -- Tailwind v4 is configured via CSS
  in `styles.css`, not a JS config file

### `defineClient()` options

```ts
defineClient(App, {
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

`defineClient()` returns a `ClientHandle` with `session` and `dispose()`.

### Built-in components

Import from `aai-ui`:

**Layout components:**

| Component       | Description                                       |
| --------------- | ------------------------------------------------- |
| `App`           | Default full UI (StartScreen + ChatView)          |
| `StartScreen`   | Centered start card; renders children after start |
| `ChatView`      | Chat interface (header + messages + controls)     |
| `SidebarLayout` | Two-column layout with sidebar + main area        |
| `Controls`      | Stop/Resume + New Conversation buttons            |
| `MessageList`   | Messages with auto-scroll, tool calls, transcript |

`StartScreen` props: `{ children, icon?, title?, subtitle?, buttonText? }`
`ChatView` props: `{ icon? }` -- optional element rendered
before the title in the header
`SidebarLayout` props: `{ sidebar, children, width?, side? }`

**Atomic components:**

| Component       | Props                        | Description                   |
| --------------- | ---------------------------- | ----------------------------- |
| `ToolCallBlock` | `{ toolCall: ToolCallInfo }` | Collapsible tool call display |

State indicator, error banner, transcript, and thinking indicator are built
into `ChatView` and `MessageList` -- no standalone imports needed.

**Hooks:**

- `useAutoScroll()` -- returns a `RefObject<HTMLDivElement>` to attach to a
  sentinel div. Auto-scrolls when messages or utterances change.
- `useClientConfig()` -- returns the `title` and `theme` passed to
  `defineClient()`.

### Session API (`useSession()`)

`useSession()` returns a `VoiceSession` object with reactive signals and
control methods:

```ts
const session = useSession();
// session.state, session.started, session.running, session.start(), session.toggle(), etc.
```

| Signal / field                 | Type                   | Description                                                     |
| ------------------------------ | ---------------------- | --------------------------------------------------------------- |
| `session.state.value`          | `AgentState`           | "disconnected", "connecting", "ready", "listening", etc.        |
| `session.messages.value`       | `Message[]`            | `{ role, content }` objects                                     |
| `session.toolCalls.value`      | `ToolCallInfo[]`       | `{ toolCallId, toolName, args, status, result? }` -- tool calls |
| `session.userUtterance.value`  | `string \| null`       | `null` = not speaking, `""` = speech detected, string = text    |
| `session.agentUtterance.value` | `string \| null`       | `null` = not speaking, string = streaming agent response text   |
| `session.error.value`          | `SessionError \| null` | `{ code, message }`                                             |
| `session.disconnected.value`   | `object \| null`       | `{ intentional: boolean }` when disconnected, `null` otherwise  |
| `session.started.value`        | `boolean`              | Whether session has been started                                |
| `session.running.value`        | `boolean`              | Whether session is active                                       |

**Methods:** `session.start()`, `session.toggle()`,
`session.reset()`, `session.disconnect()`, `session.cancel()`

All signals are `Signal<T>` from `@preact/signals`. Read `.value` to get the
current value; Preact re-renders automatically when signals change.

**Hooks:**

| Hook                                                | Description                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `useToolResult((toolName, result, tc) => {})`       | Fires once per completed tool call with parsed JSON result. Use for carts, scoreboards, etc. |
| `useToolResult<R>("tool_name", (result, tc) => {})` | Fires only for the named tool, with `result` typed as `R`.                                   |

### Custom UI data flow

When a tool executes on the server, the result flows to the UI as follows:

```text
Tool returns object on server
  -> server sends "tool_call" (status: "pending", no result)
  -> server sends "tool_call_done"  (status: "done", result as JSON string)
  -> session.toolCalls signal updates
  -> useToolResult fires callback with (toolName, parsedResult, toolCallInfo)
  -> your component updates local state via useState
```

#### `useToolResult` in detail

```ts
useToolResult(callback: (toolName: string, result: unknown, toolCall: ToolCallInfo) => void): void
```

| Parameter  | Type           | Description                                                                                                         |
| ---------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `toolName` | `string`       | Name of the tool that completed                                                                                     |
| `result`   | `unknown`      | **Parsed JSON** -- the hook parses the raw JSON string for you. Falls back to the raw string if JSON parsing fails. |
| `toolCall` | `ToolCallInfo` | Full metadata: `{ toolCallId, toolName, args, status, result, afterMessageIndex }`                                  |

**When does it fire?** Exactly **once per completed tool call**. It tracks
`toolCallId` internally, so it never fires twice for the same call -- even
when the `toolCalls` signal updates for unrelated reasons.

**What about multiple calls to the same tool?** Each call has a unique
`toolCallId`. If the agent calls `get_recipe` three times, your callback
fires three times -- once for each call -- with the individual result. Use
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
  toolCallId: string;            // Unique ID -- used for deduplication
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
import { ChatView, defineClient, useSession, useToolResult } from "@alexkroman1/aai-ui";

interface Recipe { name: string; ingredients: string[]; steps: string[] }

function RecipeAgent() {
  const session = useSession();
  const [recipe, setRecipe] = useState<Recipe | null>(null);

  useToolResult((toolName, result: any) => {
    if (toolName === "get_recipe" && result.recipe) {
      setRecipe(result.recipe);
    }
  });

  if (!session.started.value) return <button onClick={() => session.start()}>Start</button>;

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

defineClient(RecipeAgent);
```

#### Handling multiple tool calls of the same name

If the agent calls `get_recipe` multiple times (e.g. user asks for a different
recipe), each call fires the callback separately. Store a list or replace the
previous value -- whatever your UI needs:

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
// BAD -- duplicates on every signal update
useEffect(() => {
  for (const tc of session.toolCalls.value) {
    if (tc.status === "done") setCart((prev) => [...prev, tc.result]);
  }
}, [session.toolCalls.value]);

// GOOD -- fires once per completed call
useToolResult((toolName, result) => {
  if (toolName === "add_item") setCart((prev) => [...prev, result.item]);
});
```

**Signal semantics for utterances:**

- `userUtterance`: `null` = user is not speaking, `""` = speech detected but
  no text yet (show "..."), non-empty string = partial/final transcript
- `agentUtterance`: `null` = agent is not speaking, non-empty string =
  streaming response text (cleared when final `agent_transcript` message
  arrives)
- `disconnected`: `null` = connected, `{ intentional: true }` = user
  disconnected, `{ intentional: false }` = unexpected disconnect (show
  reconnect UI)

**Message type:** `{ role: "user" | "assistant"; content: string }`.

### Showing tool calls in custom UI

```tsx
import "aai-ui/styles.css";
import { defineClient, ToolCallBlock, useSession } from "@alexkroman1/aai-ui";

function App() {
  const session = useSession();
  if (!session.started.value) return <button onClick={() => session.start()}>Start</button>;

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

defineClient(App);
```

### Building dynamic UI from tool results

Use `useToolResult` to update local state whenever a tool completes. See
the **Custom UI data flow** section above for the full reference, including
callback signature, `ToolCallInfo` type, and anti-patterns.

**Sharing types between tools and client:** Create a `shared.ts` file with
your tool result types, then import it from both tool files and `client.tsx`:

```ts
// shared.ts -- imported by both tools and client.tsx
export interface CartItem { id: number; name: string; price: number }
```

```tsx
// client.tsx -- typed tool results
import "aai-ui/styles.css";
import { useState } from "preact/hooks";
import { ChatView, SidebarLayout, StartScreen, defineClient, useToolResult } from "@alexkroman1/aai-ui";
import type { CartItem } from "./shared.ts";

function ShopAgent() {
  const [cart, setCart] = useState<CartItem[]>([]);

  useToolResult((toolName, result: any) => {
    if (toolName === "add_item") setCart((prev) => [...prev, result.item]);
    if (toolName === "remove_item") setCart((prev) => prev.filter((i) => i.id !== result.removedId));
    if (toolName === "clear_cart") setCart([]);
  });

  const sidebar = (
    <div class="p-4">
      <h3 class="text-aai-text font-bold">Cart ({cart.length})</h3>
      {cart.map((i) => <p key={i.id} class="text-aai-text text-sm">{i.name} -- ${i.price}</p>)}
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

defineClient(ShopAgent);
```

### Reacting to agent state

```tsx
import "aai-ui/styles.css";
import { useEffect } from "preact/hooks";
import { ChatView, defineClient, StartScreen, useSession } from "@alexkroman1/aai-ui";

function App() {
  const session = useSession();

  useEffect(() => {
    // Run side effects when state changes
    if (session.state.value === "speaking") {
      // Agent is speaking -- e.g., show animation
    }
  }, [session.state.value]);

  return (
    <StartScreen>
      <ChatView />
    </StartScreen>
  );
}

defineClient(App);
```

The `ChatView` component includes a built-in state indicator in its header.
Pass an `icon` prop to customize the icon shown next to the title.

### Styling custom UIs

#### How styling works

The SDK has three styling layers, from simplest to most flexible:

1. **Theme in agent.json** -- set 5 core colors in `agent.json` `theme` field
   for quick branding
2. **CSS custom property overrides** -- override any `--color-aai-*` token in
   your own CSS for full control over the design system
3. **Tailwind classes + custom CSS** -- use Tailwind utility classes for layout
   and custom styles, plus injected `<style>` tags for keyframes/media queries

#### Tailwind CSS v4 (no config file)

The bundler uses **Tailwind CSS v4** with the `@tailwindcss/vite` plugin.
Tailwind is compiled at bundle time -- it scans your `client.tsx` for class
names and generates only the CSS you use.

**Important:** Tailwind v4 is configured entirely via CSS (`styles.css`), not
via JavaScript. **A `tailwind.config.js` file in your project will be
ignored.** To extend the theme, override CSS custom properties instead (see
below).

#### Layer 1: Theme in agent.json (quick branding)

Set colors in `agent.json` to override the 5 core design tokens without
writing any CSS:

```json
{
  "name": "My Agent",
  "theme": {
    "bg": "#1a1a2e",
    "primary": "#e94560",
    "text": "#eaeaea",
    "surface": "#16213e",
    "border": "#0f3460"
  }
}
```

Or pass them to `defineClient()` in `client.tsx` for the same effect:

```ts
defineClient(App, {
  theme: {
    bg: "#1a1a2e",
    primary: "#e94560",
    text: "#eaeaea",
    surface: "#16213e",
    border: "#0f3460",
  },
});
```

#### Layer 2: CSS custom property overrides (full token control)

For tokens beyond the 5 theme props (state colors, fonts, radius, etc.),
override CSS custom properties in an injected `<style>` tag or in your
`client.tsx`:

```tsx
function App() {
  return (
    <>
      <style>{`
        :root {
          --color-aai-state-listening: #00bfff;
          --color-aai-state-speaking: #ff6b6b;
          --radius-aai: 12px;
          --font-aai: "Roboto", system-ui, sans-serif;
        }
      `}</style>
      {/* your UI */}
    </>
  );
}
```

All `--color-aai-*` and `--font-aai*` tokens are live CSS custom properties --
overriding them changes every component that references them.

#### Layer 3: Tailwind classes + custom CSS

Prefer Tailwind classes over inline styles -- all design tokens work as
classes: `bg-aai-surface` not `style={{ background: "var(--color-aai-surface)" }}`,
`border-t border-aai-border` not `style={{ borderTop: "1px solid ..." }}`.

Three approaches for applying styles in components:

1. **Tailwind classes** -- `class="flex items-center gap-2 bg-aai-surface"`
2. **Inline styles** -- only for dynamic/computed values
   (`style={{ width: pixels }}`)
3. **Injected `<style>` tags** -- for keyframes, pseudo-selectors, media
   queries:

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

#### Design tokens reference

Available as CSS custom properties and Tailwind classes:

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

State colors: `disconnected`, `connecting`, `ready`, `listening`, `thinking`,
`speaking`, `error`.

The 5 core colors (`bg`, `primary`, `text`, `surface`, `border`) can be
overridden via `agent.json` theme or `defineClient()` theme props. All tokens
can be overridden via CSS custom properties.

### Common UI patterns

**Auto-scrolling messages** -- use `useAutoScroll` for custom message lists:

```tsx
import { useAutoScroll, useSession } from "@alexkroman1/aai-ui";

function MyChat() {
  const session = useSession();
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
  const session = useSession();
  const state = session.state.value;
  const msgs = session.messages.value;
  // Use `state` and `msgs` as plain values throughout the render
}
```

## Self-hosting with `createServer()`

Agents can run anywhere (Node, Docker) without the managed platform. For
self-hosting, you still use `defineAgent()` from the SDK to create a runtime:

```ts
import { defineAgent } from "@alexkroman1/aai";
import { createRuntime, createServer } from "@alexkroman1/aai/server";

const agent = defineAgent({
  name: "My Agent",
  systemPrompt: "You are a helpful assistant.",
});

const runtime = createRuntime({ agent, env: process.env });
const server = createServer({ runtime, name: agent.name });

await server.listen(3000);
```

Run with `node server.ts` (Node >=24 strips types natively) or bundle
with your preferred tool. The server handles WebSocket connections, STT/TTS,
and the agentic loop. Each agent provides its own `ASSEMBLYAI_API_KEY` —
add it to your `.env` file for local dev, or set it as an environment variable.

**Env in self-hosted mode:** `ctx.env` is exactly the `env` record you pass to
`createRuntime({ agent, env })`. If omitted, it defaults to
`process.env`. There is no
`AAI_ENV_*` prefixing -- that only applies to the managed platform. Pass only
the keys your agent needs:

```ts
const runtime = createRuntime({
  agent,
  env: {
    ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "",
    MY_API_KEY: process.env.MY_API_KEY ?? "",
  },
});
const server = createServer({ runtime, name: agent.name });
```

### Headless voice session (no UI)

For custom frontends (React Native, vanilla JS, etc.), use
`createVoiceSession` from `@alexkroman1/aai-ui` directly instead of
`defineClient`:

```ts
import { createVoiceSession } from "@alexkroman1/aai-ui";

const session = createVoiceSession({
  platformUrl: "https://your-agent.example.com",
});

session.connect();

// Signal state -- read .value to get current state
session.state.value;          // "disconnected" | "connecting" | "listening" | ...
session.messages.value;       // ChatMessage[]
session.toolCalls.value;      // ToolCallInfo[]
session.userUtterance.value;  // live STT transcript or null
session.error.value;          // SessionError | null

// Session controls
session.cancel();             // cancel current agent turn
session.resetState();         // clear messages without disconnecting
session.reset();              // full reset: clear + reconnect
session.disconnect();         // close connection
```

This gives you full control over the voice session lifecycle without Preact or
the default UI components.

## Useful free API endpoints

These public APIs require no auth and work well in voice agents:

```text
Weather (Open-Meteo):
  Geocode: https://geocoding-api.open-meteo.com/v1/search?name={city}&count=1&language=en
  Forecast: https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&timezone=auto&forecast_days=7

Currency (ExchangeRate):
  Rates: https://open.er-api.com/v6/latest/{CODE}  ->  { rates: { USD: 1.0, EUR: 0.85, ... } }

Crypto (CoinGecko):
  Price: https://api.coingecko.com/api/v3/simple/price?ids={coin}&vs_currencies={cur}&include_24hr_change=true

Drug info (FDA):
  Label: https://api.fda.gov/drug/label.json?search=openfda.generic_name:"{name}"&limit=1

Drug interactions (RxNorm):
  RxCUI: https://rxnav.nlm.nih.gov/REST/rxcui.json?name={name}
  Interactions: https://rxnav.nlm.nih.gov/REST/interaction/list.json?rxcuis={id1}+{id2}
```

Use `fetch_json` builtin tool or `fetch` in custom tools to call these.

## Testing agents

Test your agent's tools and conversation flows without audio, network, or an
LLM using the test harness from `@alexkroman1/aai/testing`.

```sh
pnpm test       # Run all tests (vitest)
```

### Setup

Tests live in `agent.test.ts` alongside `agent.json`. The project includes
vitest as a dev dependency.

### Test harness

The test harness loads tools and hooks from your agent directory and executes
them in-process with an in-memory KV store.

```ts
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("my agent", () => {
  test("tool returns expected result", async () => {
    const t = await createTestHarness(join(__dirname));
    const result = await t.executeTool("my_tool", { key: "value" });
    expect(result).toBe("expected");
  });
});
```

`await createTestHarness(agentDir, options?)` scans `tools/` and `hooks/`
subdirectories and provides:

| Method / Property              | Description                                       |
| ------------------------------ | ------------------------------------------------- |
| `executeTool(name, args)`      | Execute a single tool with full agent context     |
| `turn(text, toolCalls?)`       | Simulate a user turn with optional tool calls     |
| `messages`                     | Read-only conversation history                    |
| `kv`                           | The KV store used by the harness (for assertions) |
| `connect()` / `disconnect()`   | Fire lifecycle hooks manually                     |

Options:

```ts
await createTestHarness(join(__dirname), {
  env: { API_KEY: "test-key" },  // mock environment variables
  kv: myKvStore,                  // custom KV store (default: in-memory)
  sessionId: "test-session",      // custom session ID
});
```

### Simulating turns with tool calls

```ts
test("multi-turn pizza ordering", async () => {
  const t = await createTestHarness(join(__dirname));

  const turn1 = await t.turn("I want a large pepperoni", [
    { tool: "add_pizza", args: { size: "large", toppings: ["pepperoni"] } },
  ]);

  // Check tool calls by name
  expect(turn1.toolCalls.some(tc => tc.name === "add_pizza")).toBe(true);

  // Typed tool results
  const result = turn1.toolResult<{ added: { size: string }; orderTotal: string }>("add_pizza");
  expect(result.orderTotal).toContain("$14.99");

  // State persists across turns via KV
  const turn2 = await t.turn("Show my order", [
    { tool: "view_order", args: {} },
  ]);
  const order = turn2.toolResult<{ pizzas: unknown[] }>("view_order");
  expect(order.pizzas).toHaveLength(1);
});
```

### TurnResult API

| Method / Property      | Description                                     |
| ---------------------- | ----------------------------------------------- |
| `toolResult<T>(name)`  | Get result of first call to named tool          |
| `toolCalls`            | All recorded tool calls with name, args, result |

### Testing patterns

**Environment variables:**

```ts
const t = await createTestHarness(join(__dirname), { env: { MY_KEY: "test-123" } });
const result = await t.executeTool("check_key", {});
expect(result).toBe("test-123");
```

**KV persistence across turns:**

```ts
const t = await createTestHarness(join(__dirname));
await t.turn("first action", [{ tool: "increment", args: {} }]);
await t.turn("second action", [{ tool: "increment", args: {} }]);
const turn = await t.turn("check", [{ tool: "get_count", args: {} }]);
expect(turn.toolResult("get_count")).toBe(2);
```

**Conversation history:**

```ts
const t = await createTestHarness(join(__dirname));
await t.turn("Hello");
await t.turn("How are you?");
const turn = await t.turn("Count messages", [{ tool: "count_messages", args: {} }]);
// Tool has access to full message history via ctx.messages
```

## Common pitfalls

- **Using `useEffect` to build state from tool calls** -- Use `useToolResult`
  instead. It fires once per completed tool call with deduplication. Iterating
  `session.toolCalls.value` in `useEffect` causes duplicates.
- **Visual formatting in `systemPrompt`** -- Bullets, bold, numbered lists
  sound terrible when spoken. Use "First", "Next", "Finally" transitions
  instead.
- **Returning huge payloads from tools** -- Tool returns go into LLM context.
  Filter and truncate API responses to only what the agent needs.
- **Verbose systemPrompt** -- Voice responses should be 1-3 sentences. Don't
  say "provide detailed explanations" -- the agent will monologue.
- **Hardcoding secrets** -- Use `.env` for local dev, `aai secret put` for
  production. Access via `ctx.env` in both cases. Never inline keys.
- **SSRF restrictions** -- `fetch` is proxied; private/internal IPs (localhost,
  10.x, 192.168.x) are blocked.

## Troubleshooting

- **"no agent found"** -- Ensure `agent.json` exists in the current directory
- **"bundle failed"** -- TypeScript syntax error -- check imports, brackets
- **"No .aai/project.json found"** -- Run `aai deploy` first before using
  `aai secret`
- **Tool returns `undefined`** -- Make sure the execute function returns a
  value. Even `return { ok: true }` is better than an implicit void return.
- **Agent doesn't use a tool** -- Check `description` is clear about when to
  use it. The LLM relies on the description to decide.
- **KV reads return `null`** -- Keys are scoped per agent deployment. A
  redeployment with a new slug creates a fresh KV namespace.
