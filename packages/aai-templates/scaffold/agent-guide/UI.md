# The browser client — `client.tsx`

Part of the aai authoring guide (start with the core guide). A voice agent's
page mounts with `mountClient()`; a workflow app's mounts with `mountPage()`
(see "The page" in `WORKFLOWS.md`). Both are React 19 + Tailwind v4, bundled
by the CLI with no `vite.config.ts`.

## Custom UI — `mountClient()`

File: `client.tsx` alongside `agent.ts`. Uses **React** (not Preact).
Always import `"@alexkroman1/aai-ui/styles.css"` first.

### Tier 1 — config only (default UI)

```tsx
/// <reference types="vite/client" />
import "@alexkroman1/aai-ui/styles.css";
import { mountClient } from "@alexkroman1/aai-ui";

mountClient({ name: "My Agent" });
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

mountClient({ name: "My Agent", sidebar: Sidebar });
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

| Field          | Type                     | Default   | Description                              |
| -------------- | ------------------------ | --------- | ---------------------------------------- |
| `name`         | `string`                 | —         | Header/start screen title (tier 1)       |
| `component`    | `ComponentType`          | —         | Custom root component (tier 2)           |
| `sidebar`      | `ComponentType`          | —         | Sidebar alongside default chat (tier 1)  |
| `sidebarWidth` | `string`                 | `"18rem"` | CSS width of sidebar                     |
| `theme`        | `ClientTheme`            | —         | `{ bg, primary, text, surface, border }` |
| `target`       | `string \| HTMLElement`  | `"#app"`  | Mount target                             |
| `tools`        | `ToolDisplayConfig`      | —         | Icon/label overrides per tool name       |
| `client`       | `string \| () => string` | —         | `?client=`; `"auto"` = per-browser id    |

Beside a `component`, `sidebar` still renders; `name` becomes the page title.

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

Methods: `start()`, `toggle()`, `cancel()`, `disconnect()`, `resetState()`,
and:

- `end()` hangs up: `started` goes `false`; the next `start()` is a new
  session (fresh tool state, greeting). For End/Hang up/New game.
- `reset()` clears the conversation, keeping the call and tool state. For
  "clear chat", not ending.
- `sendText(text)`: a TYPED turn, answered as if spoken. The server's
  transcript adds it to `messages`; don't. Pipeline agents only.
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
fields off it directly (`result.price`). The type parameter is optional; add
it only when you want the shape checked.

**There is no global `JSX` namespace.** React 19 removed it, so
`JSX.Element` is `Cannot find namespace 'JSX'` (`TS2503`). Type a component's
return as `ReactNode` — `import type { ReactNode } from "react"` — which is
also what you want for anything that can be a string, an array, or null.

**`useAgentState`** — the agent's session state, pushed automatically:

```ts no-check
// shared.ts — the slot owns the shape AND its one view; `agent()` has no
// `state` field. staffPin is not in the view, so it stays server-side, and the
// agent and the client cannot name different views of it.
export const cartSlot = sessionSlot("cart", () => ({ cart: [] as Item[], staffPin: "" }), {
  view: (s) => ({ cart: s.cart }),
});
export const cartProjection = cartSlot.projected;

// agent.ts — the frame is keyed by the slot's own name
export default agent({ syncState: cartProjection });

// client.tsx — selects `state.cart`; the projection types it AND supplies the
// frame rendered before the first push, so no type argument and no `?? EMPTY`.
const view = useAgentState(cartProjection);
return <Cart items={view.cart} />;
```

Passing the projection is the shape to copy. The frame is `{ [slot]: view }`,
one key per slot. The other overloads: `useAgentState()` is the whole frame or
`null`; `useAgentState<S>("cart")` is one slot by name, `S | null` (nothing is
pushed before the first tool call); `useAgentState("cart", fallback)` returns
`S` for an empty frame you build yourself — reach for it only when the slot's
factory is expensive to import into the browser. `selectAgentState("cart")` is
the same slot as a `useSessionSelector` selector.

**Reach for this before wiring `useToolResult` into `useState`.** Without
it the pattern is: return a cart snapshot from every tool, declare a type
describing what those tools return, and mirror it into `useState` — three
things to keep in step, and the usual source of drift when you add a tool
and forget to return the snapshot from it.

`syncState` holds projections, not flags, because state often holds things
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

**`useClientTool`** — runs a server `clientTool` in the page and answers the
model with the handler's return value (see "A tool the BROWSER runs" in `TOOLS.md`):

```tsx
import { useClientTool } from "@alexkroman1/aai-ui";

export function ConfirmTool({ ask }: { ask: (question: string) => Promise<boolean> }) {
  useClientTool<{ question: string }>("confirm", async ({ question }) => ({
    approved: await ask(question),
  }));
  return null;
}
```

**Anti-pattern:** Do NOT use `useEffect` + `toolCalls` to build derived
state. Use `useToolResult` — it deduplicates. The `useEffect` pattern
re-processes every tool call on every render, causing duplicates.

## Components

Available from `@alexkroman1/aai-ui`:

| Component           | Props                                                              | Description                                                                                                               |
| ------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `StartScreen`       | `children` (**required**)`, icon?, title?, subtitle?, buttonText?` | **Wrapper, never self-closing.** Shows the start card, then renders `children` — your whole app — once the session starts |
| `ChatView`          | `icon?, title?`                                                    | Chat interface (header + messages + controls)                                                                             |
| `SidebarLayout`     | `sidebar, children, sidebarWidth?, sidebarPosition?`               | Two-column layout                                                                                                         |
| `MessageList`       | —                                                                  | Messages with auto-scroll, tool calls, transcript                                                                         |
| `Controls`          | —                                                                  | Stop/Resume + New Conversation buttons                                                                                    |
| `Button`            | —                                                                  | Styled button                                                                                                             |
| `UploadProgressBar` | `upload, onPause?, onResume?`                                      | Bytes in flight, with pause/resume                                                                                        |

**Forms are declared, not written.** `<Form onSubmit>` collects typed values off
the DOM and hands them over once the browser's own validation passes; the field
components — `TextField`, `TextAreaField`, `NumberField`, `SelectField`,
`CheckboxField`, `FileField` and `SubmitButton` — are plain named inputs, and
`Field`/`FieldShell` are what a custom control wraps itself in to match them.
For a workflow app there is usually no field markup at all: `<WorkflowFields
workflow="name" />` fetches that workflow's input schema and renders a control
per field, so a page written against one workflow serves another.

```tsx no-check
import { Form, WorkflowFields } from "@alexkroman1/aai-ui";

<Form onSubmit={(values) => submit(values)} error={error}>
  <WorkflowFields workflow="digest" />
</Form>;
```

`transcription-workflow` is the all-declared version; `link-digest-workflow`
writes its form by hand, which is what the two are for.

The usual shape — note `StartScreen` **wraps** the app rather than sitting
beside it; writing `<StartScreen ... />` self-closing is a `TS2741:
Property 'children' is missing` build error:

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

- **Tailwind CSS v4** — compiled at bundle time, configured via CSS.
  Do NOT create `tailwind.config.js` — it will be ignored.
- Use Tailwind classes for layout, `useTheme()` for dynamic colors.
- Set theme: `mountClient({ theme: { bg, primary, text, surface, border } })`.
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
