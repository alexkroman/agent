# UI Simplification for Claude Code Generation

## Goal

Make the aai-ui SDK surface small and predictable enough that Claude Code
can reliably generate correct custom agent UIs without deep knowledge of
aai-ui internals.

## Decisions

- **React 19** replaces Preact + Signals. Claude Code generates correct
  React far more reliably.
- **Headless hooks** are the primary API. Components are optional building
  blocks.
- **Tailwind for layout, typed theme for colors.** Zero custom Tailwind
  tokens. `useTheme()` returns a typed object; TypeScript catches typos.
- **Two-tier `defineClient`:** config-only for simple agents, component
  mode for complex ones.
- **Full rewrite of all 8 custom templates** to the new API. Templates are
  internal examples, not user-facing contracts.
- **Flatten test harness imports.** Single `@alexkroman1/aai/testing`
  export for `createTestHarness`, `toHaveCalledTool`, and all matchers.

## Headless Hooks API

Names align with the S2S protocol.

### `useSession()`

```tsx
const session = useSession();

// State (names match S2S events)
session.state            // "disconnected" | "connecting" | "ready"
                         //   | "listening" | "thinking" | "speaking"
session.messages         // ChatMessage[]
session.toolCalls        // ToolCallInfo[] — { callId, name, args, result, status }
session.userTranscript   // string | null (matches S2S "userTranscript")
session.agentTranscript  // string | null (matches S2S "agentTranscript")
session.error            // { code, message } | null
session.started          // boolean
session.running          // boolean

// Methods
session.start()          // begin session
session.cancel()         // interrupt current turn (matches "cancel" message)
session.reset()          // clear + reconnect (matches "reset" message)
session.disconnect()     // end session (matches S2S close())
session.toggle()         // pause/resume
```

### `useTheme()`

```tsx
const theme = useTheme();

theme.bg       // string — page background
theme.primary  // string — accent color
theme.text     // string — default text color
theme.surface  // string — card/panel backgrounds
theme.border   // string — borders and dividers
```

### `useToolResult(name?, callback)`

```tsx
useToolResult("add_pizza", (result, toolCall) => {
  // toolCall: { callId, name, args }
  setOrder(prev => ({
    ...prev,
    pizzas: [...prev.pizzas, result.added],
  }));
});

// Or receive all tool results:
useToolResult((name, result, toolCall) => { ... });
```

Fires exactly once per completed tool call. Deduplication handled
internally via React refs.

### `useToolCallStart(callback)`

```tsx
useToolCallStart("search", ({ callId, name, args }) => {
  setSearching(true);
});
```

## `defineClient` API

### Tier 1: Config-only

Covers ~80% of agents. No JSX, no component imports.

```tsx
import { defineClient } from "@alexkroman1/aai-ui";

defineClient({
  title: "Pizza Ordering",
  theme: {
    bg: "#1a1a1a",
    primary: "#e55",
    text: "#f0f0f0",
    surface: "#222",
    border: "#333",
  },
  sidebar: OrderPanel,        // React component, uses hooks internally
  sidebarWidth: "20rem",      // optional, default "18rem"
  tools: {
    add_pizza:   { icon: "🍕", label: "Adding pizza" },
    place_order: { icon: "📦", label: "Placing order" },
  },
});
```

The shell renders StartScreen, ChatView, MessageList, and Controls
automatically. The `sidebar` component receives no props — it uses
`useSession()` and `useToolResult()` to get state.

### Tier 2: Full component

For UIs that need complete control over layout and rendering.

```tsx
import { defineClient, useSession, useToolResult, useTheme }
  from "@alexkroman1/aai-ui";

function MyCustomApp() {
  const session = useSession();
  const theme = useTheme();
  // Pure React + Tailwind — no aai-ui components required
  return <div>...</div>;
}

defineClient({ component: MyCustomApp, theme: { ... } });
```

Optional building blocks available if wanted:

```tsx
import { ChatView, SidebarLayout } from "@alexkroman1/aai-ui";
```

### Config shape

`sidebar` and `component` are mutually exclusive. If `component` is
provided, the shell is bypassed entirely — `sidebar`, `tools`, and
`title` are ignored. TypeScript enforces this via a discriminated union:

```tsx
type ClientConfig =
  | { component: React.ComponentType; theme?: ClientTheme; target?: string }
  | { title?: string; theme?: ClientTheme; sidebar?: React.ComponentType;
      sidebarWidth?: string; tools?: ToolDisplayConfig; target?: string };
```

### What `defineClient` does internally

1. Creates the session (WebSocket + audio)
2. Wraps component in `<SessionProvider>` + `<ThemeProvider>`
3. Mounts to `#app` (or custom `target`)
4. Returns `{ session, dispose() }` handle

## Styling Strategy

**Rule: Tailwind for layout, typed theme object for colors.**

```tsx
const theme = useTheme();

<div
  className="flex gap-4 p-4 rounded-lg border"
  style={{ background: theme.surface, borderColor: theme.border }}
>
  <h2 className="text-lg font-semibold" style={{ color: theme.primary }}>
    Order Summary
  </h2>
</div>
```

| Concern | Mechanism | Example |
|---------|-----------|---------|
| Layout | Tailwind | `flex`, `grid`, `gap-4`, `items-center` |
| Spacing | Tailwind | `p-4`, `m-2`, `space-y-2` |
| Sizing | Tailwind | `w-full`, `h-screen`, `max-w-md` |
| Responsive | Tailwind | `md:grid-cols-2`, `lg:w-1/3` |
| Typography | Tailwind | `text-sm`, `font-semibold` |
| Border radius | Tailwind | `rounded-lg`, `rounded-full` |
| Colors | `style` + `useTheme()` | `style={{ color: theme.primary }}` |
| Backgrounds | `style` + `useTheme()` | `style={{ background: theme.surface }}` |
| Borders (color) | `style` + `useTheme()` | `style={{ borderColor: theme.border }}` |

No custom Tailwind tokens. `styles.css` shrinks to:

```css
@import "tailwindcss";
```

Default theme applied when no `theme` option is provided:

```tsx
const defaultTheme = {
  bg: "#101010",
  primary: "#fab283",
  text: "rgba(255, 255, 255, 0.94)",
  surface: "#151515",
  border: "#282828",
};
```

## Component Exports

Five optional building blocks for tier 2 UIs:

| Component | Purpose | Key Props |
|-----------|---------|-----------|
| `StartScreen` | Centered card until session starts | `title`, `children` |
| `ChatView` | Header + messages + controls | `title`, `className` |
| `MessageList` | Scrollable messages | `className` |
| `SidebarLayout` | Two-column layout | `sidebar`, `sidebarWidth`, `sidebarPosition` |
| `Button` | Styled button | `variant`, `size`, `onClick`, `children` |

Removed from public API:
- `App` — replaced by `defineClient` config tier
- `ToolCallBlock` — internal, rendered by `MessageList` using tool config
- `Controls` — internal, rendered by `ChatView`

## Full Public API Surface

```
// Entry
defineClient(config)

// Hooks
useSession()
useTheme()
useToolResult(name?, callback)
useToolCallStart(callback)

// Components (optional)
StartScreen, ChatView, MessageList, SidebarLayout, Button

// Types
AgentState, ChatMessage, ToolCallInfo, SessionError, ClientTheme
```

Three hooks, five components, one entry function, five types.

## Test Harness Imports

Flatten `@alexkroman1/aai/testing` and `@alexkroman1/aai/testing/matchers`
into a single export:

```tsx
// Before (two imports from two subpaths)
import { createTestHarness } from "@alexkroman1/aai/testing";
import { toHaveCalledTool } from "@alexkroman1/aai/testing/matchers";

// After (single import)
import { createTestHarness, toHaveCalledTool } from "@alexkroman1/aai/testing";
```

Re-export all matchers from the main `./testing` entry point. The
`./testing/matchers` subpath can remain for backwards compatibility but
is no longer the recommended import.

## Internal Architecture

### Session layer split

```
session-core.ts    — framework-agnostic: WebSocket, audio, state machine
                     Emits events or uses internal subscription pattern.

useSession.ts      — React hook: subscribes to session-core via
                     useSyncExternalStore, returns plain React state.

useToolResult.ts   — React hook: watches toolCalls from useSession,
                     deduplicates via React refs, fires callback.

defineClient.tsx   — createRoot().render() with SessionProvider +
                     ThemeProvider.
```

`session-core.ts` does not depend on React. The React layer is a thin
subscription adapter.

### Audio layer

Untouched. AudioWorklet is browser-native and framework-agnostic.
`session-core.ts` manages audio lifecycle the same way `session.ts`
does today.

## React Migration

### Dependencies

```
Remove:  preact, @preact/signals, @preact/signals-core, @preact/preset-vite
Add:     react, react-dom, @vitejs/plugin-react
```

### aai-ui file changes

| File | Action |
|------|--------|
| `session.ts` | Split into `session-core.ts` + `useSession.ts` |
| `hooks.ts` | Rewrite: signals to React refs/effects |
| `context.ts` | Rewrite: Preact context to React context, add ThemeProvider |
| `define-client.tsx` | Rewrite: `render()` to `createRoot().render()` |
| `audio.ts` | Untouched |
| `worklets/` | Untouched |
| `types.ts` | Update: `callId`/`name` field renames, add `ClientTheme` |
| `styles.css` | Shrink: remove `@theme` block |
| `index.ts` | Update exports |
| `components/*.tsx` | Rewrite: Preact to React, signals to props/state |

### aai-templates file changes

| File | Action |
|------|--------|
| `scaffold/package.json` | `preact` to `react` + `react-dom` |
| `scaffold/vite.config.ts` | Preact plugin to React plugin |
| `scaffold/CLAUDE.md` | Rewrite UI section for new API |
| 13 simple `client.tsx` | 4 lines to 1 line |
| 5 custom `client.tsx` | Full rewrite with new hooks + React |
| 3 `shared.ts` | Update `ToolCallInfo` field names |

### What doesn't change

- All `agent.ts` files
- Wire protocol
- `aai-server` package
- `aai-cli` package
- Agent-side test harness (beyond import flattening)

## Template Rewrites

### Simple templates (13)

```tsx
// Before (4 lines)
import "@alexkroman1/aai-ui/styles.css";
import { App, defineClient } from "@alexkroman1/aai-ui";
defineClient(App);

// After (1 line)
import { defineClient } from "@alexkroman1/aai-ui";
defineClient({ title: "Simple Agent" });
```

### Custom template estimates

| Template | Current Lines | Estimated Lines | Reduction |
|----------|--------------|-----------------|-----------|
| night-owl | 182 | ~80 | 56% |
| pizza-ordering | 225 | ~100 | 56% |
| infocom-adventure | 299 | ~120 | 60% |
| dispatch-center | 440 | ~200 | 55% |
| solo-rpg | 923 | ~450 | 51% |

All custom templates use `useSession()` + `useToolResult()` +
`useTheme()` + standard React + Tailwind. No Preact signals, no
`.value` access, no custom CSS tokens.

## Risk Areas

1. **Audio worklet initialization** — after splitting `session.ts`,
   audio lifecycle wiring needs careful integration testing.
2. **React 19 version pinning** — pin exact React 19 version, not
   `latest`.
3. **Vite HMR** — React plugin handles HMR differently than Preact.
   Dev mode needs testing.
4. **Bundle size** — ~37KB increase (Preact ~3KB vs React ~40KB).
   Acceptable for agent UIs but should measure.
