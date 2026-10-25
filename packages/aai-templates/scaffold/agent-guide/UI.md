# The browser client — `client.tsx`

Part of the aai authoring guide (start with the core guide). A voice agent's
page mounts with `mountClient()`; a workflow app's mounts with `mountPage()`
(see "The page" in `WORKFLOWS.md`). Both are React 19 + Tailwind v4, bundled by
the CLI with no `vite.config.ts`.

## Custom UI — `mountClient()`

File: `client.tsx` alongside `agent.ts`. Uses **React** (not Preact). Always
import `"@alexkroman1/aai-ui/styles.css"` first.

### Tier 1 — config only (default UI)

```tsx
/// <reference types="vite/client" />
import "@alexkroman1/aai-ui/styles.css";
import { mountClient } from "@alexkroman1/aai-ui";

// The title, greeting and each tool's icon come from the server (`agent()` and
// `tool({ ui })`), so there is nothing to restate here.
mountClient({ theme: { primary: "#e05a3a", mode: "dark" } });
```

### Tier 1 with sidebar

```tsx
/// <reference types="vite/client" />
import "@alexkroman1/aai-ui/styles.css";
import { mountClient, useEvent } from "@alexkroman1/aai-ui";
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

mountClient({ sidebar: Sidebar });
```

### Tier 2 — full custom component

```tsx
/// <reference types="vite/client" />
import "@alexkroman1/aai-ui/styles.css";
import { mountClient, useSession } from "@alexkroman1/aai-ui";

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

mountClient({ component: MyApp });
```

### `mountClient()` config

| Field          | Type                     | Default    | Description                                                          |
| -------------- | ------------------------ | ---------- | -------------------------------------------------------------------- |
| `name`         | `string`                 | the server | Page title; the agent's `name` unless overridden                     |
| `component`    | `ComponentType`          | —          | Custom root component (tier 2)                                       |
| `sidebar`      | `ComponentType`          | —          | Sidebar alongside default chat (tier 1)                              |
| `sidebarWidth` | `string`                 | `"18rem"`  | CSS width of sidebar                                                 |
| `theme`        | `ClientTheme`            | —          | `{ primary, mode?: "dark" \| "light" }`, or all five tokens (below)  |
| `css`          | `string`                 | —          | A page stylesheet (`@keyframes`, a font face) — no `<style>` element |
| `target`       | `string \| HTMLElement`  | `"#app"`   | Mount target                                                         |
| `tools`        | `ToolDisplayConfig`      | the server | Icon/label OVERRIDES per tool name; declare them on `tool({ ui })`   |
| `client`       | `string \| () => string` | —          | `?client=`; `"auto"` = per-browser id                                |

Beside a `component`, `sidebar` still renders.

### `useSession()` return type

| Field             | Type                   | Description                                                                                 |
| ----------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `state`           | `AgentState`           | `"disconnected"` `"connecting"` `"ready"` `"listening"` `"thinking"` `"speaking"` `"error"` |
| `messages`        | `ChatMessage[]`        | `{ role, content }`                                                                         |
| `toolCalls`       | `ToolCallInfo[]`       | `{ callId, name, args, status, result? }`                                                   |
| `customEvents`    | `AgentCustomEvent[]`   | `{ id, event, data }` from `ctx.send()`                                                     |
| `userTranscript`  | `string \| null`       | `null` = not speaking, `""` = speech detected, string = text                                |
| `agentTranscript` | `string \| null`       | `null` = not speaking, string = streaming response                                          |
| `error`           | `SessionError \| null` | `{ code, message }`                                                                         |
| `started`         | `boolean`              | Whether session started                                                                     |
| `running`         | `boolean`              | Whether session active                                                                      |

Methods: `start()`, `toggle()`, `cancel()`, `disconnect()`, `resetState()`, and:

- `end()` hangs up: `started` goes `false`; the next `start()` is a new session
  (fresh tool state, greeting). For End/Hang up/New game.
- `reset()` clears the conversation, keeping the call and tool state. For "clear
  chat", not ending.
- `sendText(text)`: a TYPED turn, answered as if spoken. The server's transcript
  adds it to `messages`; don't. Pipeline agents only.
- `setMicMuted(muted)`: mute without hanging up (streams silence), e.g.
  hold-to-talk. Read as `micMuted`.

## UI hooks

**`useToolResult`** — fires once per completed tool call (deduplicates by
callId):

```ts no-check
useToolResult("tool_name", (result, toolCall) => { ... })          // one tool
useToolResult((toolName, result, toolCall) => { ... })             // all tools
useToolResult<ResultType>("tool_name", (result) => { ... })        // typed (optional)
```

`result` is the tool's return value, already JSON-parsed and untyped — read
fields off it directly (`result.price`). The type parameter is optional; add it
only when you want the shape checked.

**There is no global `JSX` namespace.** React 19 removed it, so `JSX.Element` is
`Cannot find namespace 'JSX'` (`TS2503`). Type a component's return as
`ReactNode` — `import type { ReactNode } from "react"` — which is also what you
want for anything that can be a string, an array, or null.

**`useAgentState`** — the agent's session state, pushed automatically:

```ts no-check
// shared.ts — the slot owns the shape AND its one view; `agent()` names nothing.
// staffPin is not in the view, so it stays server-side, and the agent and the
// client cannot name different views of it. `sync: true` registers the
// projection (agent.ts must import this module).
export const cartSlot = sessionSlot("cart", { cart: [] as Item[], staffPin: "" }, {
  view: (s) => ({ cart: s.cart }),
  sync: true,
});

// client.tsx — selects `state.cart`; the projection types it AND supplies the
// frame rendered before the first push, so no type argument and no `?? EMPTY`.
const view = useAgentState(cartSlot.projected);
return <Cart items={view.cart} />;
```

Passing the projection is the shape to copy. The frame is `{ [slot]: view }`,
one key per slot. A SEEDED slot (a catalogue, demo accounts) declares `empty`
beside `view`, so the frame before the first push is the empty shape and the
seed never ships to the browser. The other overloads: `useAgentState()` is the
whole frame or `null`; `useAgentState<S>("cart")` is one slot by name,
`S | null` (nothing is pushed before the first tool call);
`useAgentState("cart", fallback)` returns `S` for an empty frame you build
yourself — only for a slot whose module cannot be imported into the browser at
all. `selectAgentState("cart")` is the same slot as a `useSessionSelector`
selector.

**Reach for this before wiring `useToolResult` into `useState`.** Without it the
pattern is: return a cart snapshot from every tool, declare a type describing
what those tools return, and mirror it into `useState` — three things to keep in
step, and the usual source of drift when you add a tool and forget to return the
snapshot from it.

`syncState` holds projections, not flags, because state often holds things that
should not reach a browser (keys, PINs, scratch) or cannot be serialized.
Whatever it returns is exactly what the client receives. It runs after every
tool call and is sent only when the result changed.

**`useEvent`** — fires for custom events from `ctx.send()`:

```ts no-check
useEvent<DataType>("event_name", (data) => { ... })
```

Server: `ctx.send("order", { total: "$14.99" })` — Client:
`useEvent("order", (data) => ...)`.

**`useTheme`** — returns the resolved `{ bg, primary, text, surface, border }`.

**`useRoute` / `routeFetch`** — one of the agent's own `routes`, resolved
against the page: `routeFetch("api/calls", { method: "POST", headers })` and
`useRoute("api/calls/1", { pollMs: 2000, until: (call) => call.done, headers })`,
which re-reads on that interval until `until` says so and stops on unmount. The
`headers` carry an `authorization` for an `apiKeyRoute`.

**`useToolCallStart`** — fires when a tool call begins (status `"pending"`).

**`useClientTool`** — runs a server `clientTool` in the page and answers the
model with the handler's return value (see "A tool the BROWSER runs" in
`TOOLS.md`):

```tsx
import { useClientTool } from "@alexkroman1/aai-ui";

export function ConfirmTool({ ask }: { ask: (question: string) => Promise<boolean> }) {
  useClientTool<{ question: string }>("confirm", async ({ question }) => ({
    approved: await ask(question),
  }));
  return null;
}
```

**Anti-pattern:** Do NOT use `useEffect` + `toolCalls` to build derived state.
Use `useToolResult` — it deduplicates. The `useEffect` pattern re-processes
every tool call on every render, causing duplicates.

## Components

Available from `@alexkroman1/aai-ui`:

| Component           | Props                                                              | Description                                                                                                               |
| ------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `StartScreen`       | `children` (**required**)`, icon?, title?, subtitle?, buttonText?` | **Wrapper, never self-closing.** Shows the start card, then renders `children` — your whole app — once the session starts |
| `ChatView`          | `icon?, title?`                                                    | Chat interface (header + messages + controls)                                                                             |
| `SidebarLayout`     | `sidebar, children, sidebarWidth?, sidebarPosition?`               | Two-column layout                                                                                                         |
| `MessageList`       | —                                                                  | Messages with auto-scroll, tool calls, transcript                                                                         |
| `Controls`          | —                                                                  | Stop/Resume, New Conversation and End Call buttons                                                                        |
| `Button`            | —                                                                  | Styled button                                                                                                             |
| `SessionStateDot`   | `colors?`                                                          | The live state as a dot and a word, coloured from the theme; `colors` overrides a group (`idle`/`live`/`busy`) or a state |
| `UploadProgressBar` | `upload, onPause?, onResume?`                                      | Bytes in flight, with pause/resume                                                                                        |

**Forms are declared, not written.** `<Form onSubmit>` collects typed values off
the DOM and hands them over once the browser's own validation passes; the field
components — `TextField`, `TextAreaField`, `NumberField`, `SelectField`,
`CheckboxField`, `FileField` and `SubmitButton` — are plain named inputs, and
`Field`/`FieldShell` are what a custom control wraps itself in to match them.
For a workflow app there is usually no field markup at all:
`<WorkflowFields workflow="name" />` fetches that workflow's input schema and
renders a control per scalar field, plus a `string[]` as
`<TextAreaField split="lines">` and a `{ name, text }` object as
`<FileField as="namedText">` (a draft read in the browser); `render` asks for
either by property name where the schema does not say.

```tsx no-check
import { Form, WorkflowFields } from "@alexkroman1/aai-ui";
import type agentDef from "./agent.ts";

// Typed by the app: a workflow name the agent does not declare is a compile error.
<Form onSubmit={(values) => submit(values)} error={error}>
  <WorkflowFields<typeof agentDef> workflow="redline" render={{ mustCover: "lines" }} />
</Form>;
```

**Every workflow hook takes the app type the same way** —
`useWorkflowSubmit<typeof agentDef>("redline")`, `useWorkflowStream`,
`useWorkflowRuns` — so the name is checked and the input and output are typed
from the def. What `useWorkflowSubmit` hands back carries `timing`
(press-to-settle `performance.now` marks) and `scope` (`"tab"` by default;
`"browser"` with `{ key: { storage: "local" } }`), which
`<WorkflowPendingNote submission={…}>` renders along with the upload's `paused`.
`transcription-workflow` is the all-declared form; `link-digest-workflow` writes
its form by hand, which is what the two are for.

The usual shape — note `StartScreen` **wraps** the app rather than sitting
beside it; writing `<StartScreen ... />` self-closing is a
`TS2741: Property 'children' is missing` build error:

```tsx
/// <reference types="vite/client" />
import "@alexkroman1/aai-ui/styles.css";
import { ChatView, mountClient, StartScreen } from "@alexkroman1/aai-ui";

function PizzaApp() {
  return (
    <StartScreen title="Pizza Palace" subtitle="Voice-powered ordering">
      <ChatView />
    </StartScreen>
  );
}

mountClient({ component: PizzaApp });
```

## Styling

- **Tailwind CSS v4** — compiled at bundle time, configured via CSS. Do NOT
  create `tailwind.config.js` — it will be ignored.
- Use Tailwind classes for layout, `useTheme()` for dynamic colors.
- Set theme: `mountClient({ theme: { primary, mode: "dark" } })` derives the
  four neutrals; `{ bg, primary, text, surface, border }` sets all five. The
  tokens are on `:root` as `--aai-*`, so a `css` sheet may use them.
- Override CSS custom properties for extra tokens: `--color-aai-*`,
  `--radius-aai`, `--font-aai`.
- Always import `"@alexkroman1/aai-ui/styles.css"` at the top of `client.tsx`.

### Design guidelines

A custom UI should look deliberate, not like boilerplate. When building or
restyling a `client.tsx`:

- **Color:** pick one primary brand color, 2-3 neutrals (white/grays/black
  variants), and at most 1-2 accents — 3-5 colors total. Avoid gradients unless
  asked. If you override an element's background color, also set its text color
  so contrast holds.
- **Typography:** at most 2 font families — one for headings, one for body. Body
  text 14px or larger with a relaxed line height (`leading-relaxed`).
- **Layout:** design mobile-first, then enhance with responsive prefixes (`md:`,
  `lg:`). Prefer flexbox (`flex items-center justify-between`); use grid only
  for genuinely two-dimensional layouts; avoid absolute positioning unless
  nothing else works.
- **Tailwind:** stay on the spacing scale (`p-4`, never `p-[16px]`), use `gap-*`
  between siblings rather than per-child margins, and wrap headings and key copy
  in `text-balance` or `text-pretty`.
- **Accessibility:** semantic elements (`main`, `header`, `button`), alt text on
  meaningful images, `sr-only` labels on icon-only buttons.
- **No filler:** no emojis as icons, no decorative gradient blobs or abstract
  placeholder shapes, no lorem-ipsum-looking content.
