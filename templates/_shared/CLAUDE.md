# Build a voice agent with `aai`

You are helping a user build a voice agent using the **aai** framework. Generate
or update files based on the user's description in `$ARGUMENTS`.

## Workflow

1. **Understand** — Restate what the user wants to build. If the request is
   vague, ask a clarifying question before writing code.
2. **Check existing work** — Look for a template or built-in tool that already
   does what the user needs before writing custom code.
3. **Start minimal** — Scaffold from the closest template, then layer on
   customizations. Don't over-engineer the first version.
4. **Iterate** — Make small, focused changes. Verify each change works before
   moving on.

## Getting started

### Use the `aai` CLI

Always use the `aai` CLI to scaffold, deploy, and manage agents:

```sh
aai                      # Scaffold (if needed) + deploy
aai new                  # Scaffold a new agent (interactive)
aai new -t <template>    # Scaffold from a specific template
aai deploy               # Bundle and deploy to production
aai deploy -y            # Deploy without prompts
aai deploy --dry-run     # Validate and bundle without deploying
aai env add <NAME>       # Set an environment variable on the server
aai env rm <NAME>        # Remove an environment variable
aai env ls               # List environment variable names
aai env pull             # Pull env var names into .env for local dev
```

Install: `curl -fsSL https://aai-agent.fly.dev/install | sh`

### Deploy a scaffolded project

After scaffolding with `aai new`, deploy from the project directory:

```sh
cd my-agent
aai deploy          # Bundle, check, and deploy
aai deploy -y       # Skip confirmation prompts
```

The CLI auto-detects the server URL. When running via `aai-dev` (the local
monorepo dev wrapper), it targets `http://localhost:3100` automatically.

### Start from a template

Before writing an agent from scratch, **choose the closest template** and
scaffold with `aai new -t <template_name>`. Ask the user which template fits, or
recommend one based on their description. Fall back to `simple` if nothing else
fits.

Templates are in `templates/` relative to the CLI source:

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
| `dispatch-center`   | 911 dispatch with incident triage and resource assignment. **Has custom UI.**      |
| `infocom-adventure` | Zork-style text adventure with state, puzzles, inventory. **Has custom UI.**       |
| `embedded-assets`   | FAQ bot using embedded JSON knowledge (no web search)                              |
| `support`           | RAG-powered support agent using vector_search (AssemblyAI docs example)            |
| `terminal`          | STT-only mode for voice-driven kubectl commands                                    |

### Minimal agent

Every agent lives in `agent.ts` and exports a default `defineAgent()` call:

```ts
import { defineAgent } from "aai";

export default defineAgent({
  name: "My Agent",
  instructions: "You are a helpful assistant that...",
  greeting: "Hey there. What can I help you with?",
  voice: "694f9389-aac1-45b6-b726-9d9369183238", // Sarah
});
```

### Imports

```ts
import { defineAgent } from "aai"; // Always needed
import type { BeforeStepResult, HookContext, ToolContext } from "aai"; // Type annotations
import { z } from "zod"; // Tools with typed params (included in package.json)
```

## Agent configuration

```ts
defineAgent({
  // Core
  name: string;              // Required: display name
  instructions?: string;     // System prompt (voice-first default provided)
  greeting?: string;         // Spoken on connect
  voice?: Voice;             // Cartesia voice UUID (default: Sarah)

  // Speech
  sttPrompt?: string;        // STT guidance for jargon, names, acronyms

  // Tools
  builtinTools?: BuiltinTool[];
  tools?: Record<string, ToolDef>;
  toolChoice?: ToolChoice;   // "auto" | "required" | "none" | { type: "tool", toolName }
  activeTools?: string[];    // Default active tools per turn (subset of all tools)
  maxSteps?: number | ((ctx: HookContext) => number);

  // Environment

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

### Voices

Voices use Cartesia voice UUIDs. Browse all voices at
[play.cartesia.ai](https://play.cartesia.ai).

Common voices:

| Name                  | Voice ID                               |
| --------------------- | -------------------------------------- |
| Sarah (default)       | `694f9389-aac1-45b6-b726-9d9369183238` |
| Customer Support Man  | `a167e0f3-df7e-4d52-a9c3-f949145efdab` |
| Customer Support Lady | `829ccd10-f8b3-43cd-b8a0-4aeaa81f3b30` |
| Helpful Woman         | `156fb8d2-335b-4950-9cb3-a2d33befec77` |
| Professional Woman    | `248be419-c632-4f23-adf1-5324ed7dbf1d` |
| Sweet Lady            | `e3827ec5-697a-4b7c-9704-1a23041bbc51` |
| British Lady          | `79a125e8-cd45-4c13-8a67-188112f4dd22` |
| Calm Lady             | `00a77add-48d5-4ef6-8157-71e5437b282d` |
| Laidback Woman        | `21b81c14-f85b-436d-aff5-43f2e788ecf8` |
| Storyteller Lady      | `996a8b96-4804-46f0-8e05-3fd4ef1a87cd` |
| Newslady              | `bf991597-6c13-47e4-8411-91ec2de5c466` |
| Friendly Reading Man  | `69267136-1bdc-412f-ad78-0caad210fb40` |
| Confident British Man | `63ff761f-c1e8-414b-b969-d1833d1c870c` |
| New York Man          | `34575e71-908f-4ab6-ab54-b08c95d6597d` |
| California Girl       | `b7d50908-b17c-442d-ad8d-810c63997ed9` |
| Newsman               | `d46abd1d-2d02-43e8-819f-51fb652c1c61` |
| Salesman              | `820a3788-2b37-4d21-847a-b65d8a68c99a` |
| Wise Man              | `b043dea0-a007-4bbe-a708-769dc0d0c569` |
| Child                 | `2ee87190-8f84-4925-97da-e52547f9462c` |

Any Cartesia voice UUID works — the list above is just a starting point.

Use `sttPrompt` for domain-specific vocabulary:

```ts
export default defineAgent({
  voice: "a167e0f3-df7e-4d52-a9c3-f949145efdab", // Customer Support Man
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
aai env add ASSEMBLYAI_API_KEY
aai env add MY_API_KEY

# List what's set
aai env ls

# Pull env var names into .env for local dev reference
aai env pull

# Remove a secret
aai env rm MY_API_KEY
```

Declare required env vars in the agent config so the CLI validates them at
deploy time:

```ts
export default defineAgent({
  name: "API Agent",
  env: ["ASSEMBLYAI_API_KEY", "MY_API_KEY"],
  // ...
});
```

Access secrets in tool code via `ctx.env`:

```ts
import { defineAgent } from "aai";
import { z } from "zod";

export default defineAgent({
  name: "API Agent",
  env: ["ASSEMBLYAI_API_KEY", "MY_API_KEY"],
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
import { defineAgent } from "aai";
import { z } from "zod";

export default defineAgent({
  name: "Weather Agent",
  tools: {
    get_weather: {
      description: "Get current weather for a city",
      parameters: z.object({
        city: z.string().describe("City name"),
      }),
      execute: async (args, ctx) => {
        const data = await fetch(
          `https://api.example.com/weather?q=${args.city}`,
        );
        return data.json();
      },
    },

    // No-parameter tools — omit `parameters`
    list_items: {
      description: "List all items",
      execute: () => items,
    },
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
| `visit_webpage` | Fetch URL → Markdown                           | `url`                               |
| `fetch_json`    | HTTP GET a JSON API                            | `url`, `headers?`                   |
| `run_code`      | Execute JS in sandbox (no net/fs, 30s timeout) | `code`                              |
| `vector_search` | Search the agent's RAG knowledge base          | `query`, `topK?` (default 5)        |

The agentic loop runs up to `maxSteps` iterations (default 5) and stops when the
LLM produces a text response.

### Tool context

Every `execute` function and lifecycle hook receives a context object:

```ts
ctx.sessionId; // string — unique per connection
ctx.env; // Record<string, string> — secrets from `aai env add`
ctx.abortSignal; // AbortSignal — cancelled on interruption (tools only)
ctx.state; // per-session state
ctx.kv; // persistent KV store
ctx.messages; // readonly Message[] — conversation history (tools only)
```

Hooks get `HookContext` (same but without `abortSignal` and `messages`).

### Fetching external APIs

Use `fetch` directly in tool execute functions:

```ts
execute: async (args, ctx) => {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${ctx.env.API_KEY}` },
    signal: ctx.abortSignal, // Respect interruptions
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
import { mount, useSession } from "aai/ui";

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

Import from `aai/ui`:

| Component           | Description                                        |
| ------------------- | -------------------------------------------------- |
| `App`               | Default full UI (start screen + ChatView)          |
| `ChatView`          | Chat interface with header, messages, and controls |
| `MessageBubble`     | Single message (user right-aligned, agent left)    |
| `Transcript`        | Live STT text display                              |
| `StateIndicator`    | Colored dot + agent state label                    |
| `ErrorBanner`       | Red error box with message                         |
| `ThinkingIndicator` | Animated dots during processing                    |
| `ToolCallBlock`     | Collapsible tool call display (name, args, result) |

Use `useMountConfig()` to access the `title` and `theme` passed to `mount()`.

### Session signals (`useSession()`)

`useSession()` returns
`{ session, started, running, start, toggle, reset, dispose }`. Reactive agent
data lives on `session` (a `VoiceSession`); UI-only controls are top-level.

| Signal / field                | Type                   | Description                                                                              |
| ----------------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `session.state.value`         | `AgentState`           | "disconnected", "connecting", "ready", "listening", "thinking", "speaking", "error"      |
| `session.messages.value`      | `Message[]`            | `{ role, text }` objects                                                                 |
| `session.toolCalls.value`     | `ToolCallInfo[]`       | `{ toolCallId, toolName, args, status, result?, afterMessageIndex }` — active tool calls |
| `session.userUtterance.value` | `string \| null`       | `null` = not speaking, `""` = speech detected, string = transcript                       |
| `session.error.value`         | `SessionError \| null` | `{ code, message }`                                                                      |
| `session.disconnected.value`  | `object \| null`       | `{ intentional: boolean }` when disconnected, `null` when connected                      |
| `started.value`               | `boolean`              | Whether session has started                                                              |
| `running.value`               | `boolean`              | Whether session is active                                                                |

**Methods:** `start()`, `toggle()`, `reset()`, `dispose()`

### Showing tool calls in custom UI

```tsx
import { mount, ToolCallBlock, useSession } from "aai/ui";

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

### Reacting to agent state

```tsx
import { useEffect } from "preact/hooks";
import { mount, StateIndicator, useSession } from "aai/ui";

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

The framework uses **Tailwind CSS v4** (compiled at bundle time). Three
approaches:

1. **Tailwind classes** — `class="flex items-center gap-2 bg-gray-900"`
2. **Inline styles** — `style={{ color: "red", padding: "1rem" }}`
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

**CSS custom properties** available from the theme:

- `--color-aai-bg`, `--color-aai-primary`, `--color-aai-text`
- `--color-aai-surface`, `--color-aai-border`
- `--color-aai-state-{state}` — color for each `AgentState` value

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
  CLAUDE.md         # Agent API reference (auto-generated)
  .aai/             # Build output (managed by CLI, gitignored)
    project.json    # Deploy target (slug, server URL)
    build/          # Bundle output
```

## Common pitfalls

- **Writing `instructions` with visual formatting** — Bullets, bold, numbered
  lists sound terrible when spoken. Use natural transitions: "First", "Next",
  "Finally". Write instructions as if you're coaching a human phone operator.
- **Returning huge payloads from tools** — Everything a tool returns goes into
  the LLM context. Filter, summarize, or truncate API responses before
  returning. Return only what the agent needs to formulate a spoken answer.
- **Forgetting sandbox constraints** — Agent code runs in a Deno Worker with
  _all permissions disabled_ (no net, no fs, no env). Use `fetch` (proxied
  through the host) for HTTP. Use `ctx.env` for secrets. `Deno.readFile`,
  `Deno.env.get`, and direct network access will fail silently or throw.
- **Ignoring `ctx.abortSignal`** — When the user interrupts, in-flight tool
  calls are cancelled via `ctx.abortSignal`. Long-running tools (polling,
  multi-step fetches) should check `ctx.abortSignal.aborted` or pass the signal
  to `fetch`.
- **Hardcoding secrets** — Never put API keys in `agent.ts`. Use
  `aai env add MY_KEY` to store them on the server, then access via
  `ctx.env.MY_KEY`.
- **Telling the agent to be verbose** — Voice responses should be 1-3 sentences.
  If your `instructions` say "provide detailed explanations", the agent will
  monologue. Instruct it to be brief and let the user ask follow-ups.
- **Not declaring `env`** — If your agent needs custom env vars, list them in
  the `env` array so the CLI validates they're set before deploying.
- **Forgetting SSRF restrictions on `fetch`** — The host validates all proxied
  fetch URLs. Requests to private/internal IP addresses (localhost, 10.x,
  192.168.x, etc.) are blocked.

## Troubleshooting

- **"no agent found"** — Ensure `agent.ts` exists in the current directory
- **"bundle failed"** — TypeScript syntax error — check imports, brackets
- **"No .aai/project.json found"** — Run `aai deploy` first before using
  `aai env`
- **Tool returns `undefined`** — Make sure `execute` returns a value. Even
  `return { ok: true }` is better than an implicit void return.
- **Agent doesn't use a tool** — Check `description` is clear about when to use
  it. The LLM relies on the description to decide. Also check `activeTools`
  isn't filtering it out.
- **KV reads return `null`** — Keys are scoped per agent deployment. A
  redeployment with a new slug creates a fresh KV namespace.
