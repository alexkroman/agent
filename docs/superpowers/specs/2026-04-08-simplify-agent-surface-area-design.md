# Simplify Agent Surface Area

**Date:** 2026-04-08
**Status:** Draft
**Goal:** Reduce the AAI SDK surface area so that Claude Code can author agents with minimal context, and the bundle closely matches what runs in production.

## Problem

Four pain points when Claude Code writes agents today:

1. **Too much context required.** Claude needs to understand `defineAgent`, `defineTool`, `defineToolFactory`, Zod schemas, the Vite plugin, and bundler internals to write a simple agent.
2. **Opaque bundle.** After building, the config extraction step (`node:vm` eval of the full bundle) is a black box. Debugging the gap between source and production is hard.
3. **Tangled tool files.** All tools live in a single `agent.ts` `tools: {}` object. Each tool is conceptually independent but jammed together.
4. **Zod dependency.** Requiring Zod for parameter schemas adds complexity (the externalization hack, the `Function()` issue in isolates). JSON Schema would be simpler and is what the LLM API already speaks.

## Constraints

- Primary user: Claude Code (LLM) writing agents
- Clean break from `defineAgent()` is acceptable
- Client UI in scope (secondary to agent side)

## Design

### Directory Structure

An agent is a directory:

```
my-agent/
  agent.json              # Agent identity + config (required)
  tools/                  # Custom tool handlers (optional)
    get_weather.ts
    lookup_order.ts
  hooks/                  # Lifecycle hooks (optional)
    on-connect.ts
    on-disconnect.ts
    on-user-transcript.ts
    on-error.ts
  client.tsx              # Custom UI (optional)
```

Conventions:

- **Tool name = filename** (snake_case). `tools/get_weather.ts` registers a tool named `get_weather`.
- **Hook name = filename** (kebab-case mapped to camelCase). `hooks/on-connect.ts` registers `onConnect`.
- **Presence = registration.** File exists = feature is active. Delete the file = feature is gone. No manifest to update.
- **Minimal agent = just `agent.json`.** Everything else is additive.

### agent.json

```json
{
  "name": "Weather Agent",
  "systemPrompt": "You are a weather assistant. Be concise.",
  "greeting": "Hey, what city do you want weather for?",
  "sttPrompt": "WeatherAPI, Celsius, Fahrenheit",
  "builtinTools": ["web_search", "run_code"],
  "maxSteps": 5,
  "toolChoice": "auto",
  "idleTimeoutMs": 300000,
  "theme": { "bg": "#1a1008", "primary": "#E8A025" }
}
```

Only `name` is required. Everything else has sensible defaults (default system prompt, default greeting, maxSteps=5, toolChoice="auto").

Long system prompts can use a file reference:

```json
{
  "name": "Complex Agent",
  "systemPrompt": { "$ref": "system-prompt.md" }
}
```

This is pure data. The host reads it directly — no code evaluation.

### Tool Files

Each tool is a single `.ts` file in `tools/` with three exports:

```typescript
// tools/get_weather.ts

export const description = "Get current weather for a city";

export const parameters = {
  type: "object",
  properties: {
    city: { type: "string", description: "City name" },
    units: { type: "string", enum: ["celsius", "fahrenheit"], description: "Temperature units" }
  },
  required: ["city"]
};

export default async function execute(args, ctx) {
  const resp = await fetch(`https://api.weather.com/v1?q=${args.city}&units=${args.units ?? "celsius"}`, {
    headers: { Authorization: `Bearer ${ctx.env.WEATHER_API_KEY}` }
  });
  return resp.json();
}
```

| Export | Required | Purpose |
|--------|----------|---------|
| `description` | yes | Shown to the LLM. One sentence. |
| `parameters` | no | JSON Schema object. Omit for zero-arg tools. |
| `export default` | yes | The handler. Receives `(args, ctx)`. Returns any JSON-serializable value. |

The `ctx` object:

```typescript
ctx.env         // Record<string, string> — secrets from .env / aai secret
ctx.kv          // { get, set, delete } — persistent storage
ctx.messages    // readonly Message[] — conversation history
ctx.sessionId   // string
```

No Zod. No imports from the SDK. A tool file imports nothing from `@alexkroman1/aai`.

Zero-arg tool example:

```typescript
// tools/flip_coin.ts
export const description = "Flip a coin";

export default function execute() {
  return { result: Math.random() > 0.5 ? "heads" : "tails" };
}
```

### Hook Files

Each hook is a single `.ts` file in `hooks/` with a default export:

```typescript
// hooks/on-connect.ts
export default async function onConnect(ctx) {
  const visits = (await ctx.kv.get("visit_count")) ?? 0;
  await ctx.kv.set("visit_count", visits + 1);
}
```

Available hooks:

| File | Fires when | Arguments |
|------|-----------|-----------|
| `on-connect.ts` | WebSocket session starts | `(ctx)` |
| `on-disconnect.ts` | WebSocket session ends | `(ctx)` |
| `on-user-transcript.ts` | User speech transcribed | `(text, ctx)` |
| `on-error.ts` | Runtime error occurs | `(error, ctx?)` |

`ctx` provides `env`, `kv`, `sessionId` (same as tools minus `messages`).

`resolveTurnConfig` is dropped. Dynamic `maxSteps` was used by one template. Static `maxSteps` in `agent.json` covers effectively all cases.

### No Per-Session State

The `state` concept (mutable per-session object from `state: () => ({...})`) is removed. All storage goes through `ctx.kv`.

Rationale: shared mutable state breaks file-per-tool independence. If `state.ts` defines `{ pizzas: [], nextId: 1 }`, Claude Code needs to read `state.ts` + every other tool file to understand the state shape before editing any single tool. With KV, each tool is self-contained:

```typescript
// tools/add_pizza.ts — everything it needs is in this one file
export default async function execute(args, ctx) {
  const pizzas = (await ctx.kv.get("pizzas")) ?? [];
  const nextId = (await ctx.kv.get("nextId")) ?? 1;
  const pizza = { id: nextId, ...args };
  await ctx.kv.set("pizzas", [...pizzas, pizza]);
  await ctx.kv.set("nextId", nextId + 1);
  return pizza;
}
```

### Client/UI

**Default (no `client.tsx`):** Built-in UI is served. Theming via `agent.json`:

```json
{ "theme": { "bg": "#1a1008", "primary": "#E8A025" } }
```

**Custom UI (`client.tsx`):** Same `@alexkroman1/aai-ui` API as today:

```tsx
import "@alexkroman1/aai-ui/styles.css";
import { defineClient, SidebarLayout, ChatView, useSession, useToolResult } from "@alexkroman1/aai-ui";

function MyAgent() {
  const session = useSession();
  const [orders, setOrders] = useState([]);

  useToolResult("add_pizza", (result) => {
    setOrders(prev => [...prev, result]);
  });

  return (
    <SidebarLayout sidebar={<OrderList orders={orders} />}>
      <ChatView />
    </SidebarLayout>
  );
}

defineClient(MyAgent, { title: "Pizza Palace" });
```

The UI package API is unchanged. Tool names in `useToolResult("add_pizza", ...)` match filenames in `tools/`.

### Build Process

```
Source                          Bundle
──────                          ──────
agent.json          ──copy──→   agent.json (+ resolved $ref)
tools/*.ts          ──scan──→   manifest.json (descriptions + schemas)
tools/*.ts          ──esbuild→  tools/*.js (compiled handlers)
hooks/*.ts          ──detect──→ manifest.json (hook flags)
hooks/*.ts          ──esbuild→  hooks/*.js (compiled handlers)
client.tsx          ──vite───→  client/ (SPA assets)
```

**Step 1 — Generate `manifest.json`:**

Scan `tools/*.ts`. For each file, extract the `description` and `parameters` const exports. Because these are const declarations assigned to string/object literals (no computed values, no function calls), the build step can use a lightweight AST parser (e.g., `es-module-lexer` + `JSON.parse` on the extracted expression) rather than `node:vm` eval. If a `parameters` value contains non-JSON expressions, the build fails with a clear error. Detect which `hooks/*.ts` files exist. Merge with `agent.json`.

Output:

```json
{
  "name": "Weather Agent",
  "systemPrompt": "You are...",
  "greeting": "Hey...",
  "builtinTools": ["web_search"],
  "maxSteps": 5,
  "tools": {
    "get_weather": {
      "description": "Get current weather for a city",
      "parameters": { "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] }
    }
  },
  "hooks": { "onConnect": true, "onDisconnect": false, "onUserTranscript": false, "onError": false }
}
```

The host reads only this file. No code evaluation.

**Step 2 — Bundle handlers:**

esbuild compiles `tools/*.ts` and `hooks/*.ts` into JS. No Zod externalization needed. Dependencies are bundled in.

**Step 3 — Bundle client (if present):**

Same Vite SPA build as today. Only runs if `client.tsx` exists.

**Build output:**

```
.aai/build/
  manifest.json
  tools/
    get_weather.js
  hooks/
    on-connect.js
  client/
    index.html
    assets/
```

Key properties:

- `manifest.json` IS the production config — no extraction step
- Handler `.js` files ARE what the isolate runs — no further transformation
- No Zod, no `Function()` hack, no `node:vm` eval
- Build is fast — esbuild for handlers, Vite only for client SPA

### Runtime Dispatcher

The isolate runs a simple message dispatcher:

```typescript
// Pseudocode — what runs inside the isolate
import * as tools from "./tools/*.js";
import * as hooks from "./hooks/*.js";

while (true) {
  const msg = await rpc.recv();

  if (msg.type === "tool") {
    const tool = tools[msg.name];
    const ctx = { env, kv, messages: msg.messages, sessionId: msg.sessionId };
    const result = await tool.default(
      tool.parameters ? validate(msg.args, tool.parameters) : msg.args,
      ctx
    );
    rpc.send(msg.id, { result: JSON.stringify(result) });
  }

  if (msg.type === "hook") {
    const hook = hooks[msg.hook];
    const ctx = { env, kv, sessionId: msg.sessionId };
    if (msg.hook === "onUserTranscript") {
      await hook.default(msg.text, ctx);
    } else if (msg.hook === "onError") {
      await hook.default(msg.error, ctx);
    } else {
      await hook.default(ctx);
    }
    rpc.send(msg.id, {});
  }
}
```

Comparison to today:

| Aspect | Today | New |
|--------|-------|-----|
| Agent loading | `node:vm` evals full bundle, extracts `defineAgent` return | Import handler files directly |
| Tool dispatch | `agent.tools[name].execute(args, ctx)` | `tools[name].default(args, ctx)` |
| Schema validation | Zod `.parse()` | JSON Schema `validate()` (Ajv or similar) |
| State management | Per-session `stateMap` + `state()` factory | `ctx.kv` only |
| Hook dispatch | `createAgentHooks()` callback map | Direct import from `hooks/*.js` |
| Config source | Extracted at build time via `node:vm` | `manifest.json` read as-is |

**Self-hosted mode** works identically but in-process (no isolate):

```typescript
const server = await createServer({ agentDir: "./my-agent" });
```

In dev mode, the server watches the directory for changes and reloads handlers.

### Migration

A current `defineAgent` agent maps mechanically to the new format:

1. Extract config fields to `agent.json`
2. Each tool to `tools/<name>.ts` with `description`, `parameters` (Zod to JSON Schema), `export default execute`
3. Each hook to `hooks/<name>.ts`
4. `state` mutations to `ctx.kv.get/set` calls
5. Delete all `import { ... } from "@alexkroman1/aai"` and `import { z } from "zod"`

This is automatable via codemod or CLI command (`aai migrate`).

## Summary

| Metric | Today | New |
|--------|-------|-----|
| Concepts to learn | `defineAgent`, `defineTool`, `defineToolFactory`, Zod, Vite plugin, bundler | 1 JSON file + 1 file pattern |
| SDK imports for agent code | `@alexkroman1/aai`, `zod` | None |
| Files to create a tool | 0 (edit agent.ts) | 1 (create `tools/<name>.ts`) |
| Build steps | Vite SSR + `node:vm` eval + Zod externalization | AST scan + esbuild |
| Bundle = production? | No (extraction step transforms) | Yes (`manifest.json` + handler `.js`) |
| File independence | No (all tools in one object) | Yes (each tool is a standalone file) |
