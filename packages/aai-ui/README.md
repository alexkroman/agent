# @alexkroman1/aai-ui

The browser client for aai voice agents: React 19 components, hooks, and a
framework-agnostic session core (WebSocket + microphone + playback).

```sh
npm i @alexkroman1/aai-ui react react-dom
```

Every agent gets this UI for free — `aai dev` and deployed agents serve a
default client built from this package. Install it directly when the agent
has its own `client.tsx`.

## A custom client

`client()` mounts the default chat shell with your sidebar, or replaces the
whole UI with a custom component:

```tsx
import "@alexkroman1/aai-ui/styles.css";
import { client, useAgentState, useTheme } from "@alexkroman1/aai-ui";

type OrderView = { items: string[]; total: string };

function OrderSidebar() {
  const theme = useTheme();
  // Server state projected by the agent's `syncState`, pushed after every
  // tool call.
  const order = useAgentState<OrderView>() ?? { items: [], total: "$0.00" };
  return (
    <div style={{ color: theme.text }}>
      {order.items.map((item) => (
        <div key={item}>{item}</div>
      ))}
      <strong style={{ color: theme.primary }}>{order.total}</strong>
    </div>
  );
}

// `sidebar` takes the COMPONENT, not an element — the shell renders it.
client({ sidebar: OrderSidebar });
```

## Hooks

Inside components rendered by `client()`:

- `useSession()` — connection state, transcript, `connect`/`disconnect`.
- `useAgentState<T>()` — the agent's `syncState` projection, live.
- `useToolResult(name, cb)` / `useToolCallStart(name, cb)` — observe tool
  calls as they run (e.g. to render a card per result).
- `useEvent(name, cb)` — custom events the agent pushes with `ctx.send`.
- `useTheme()` — the resolved theme colors for custom components.

For a non-React integration, `createSessionCore()` exposes the same session
as a plain store with an immutable snapshot per change.

## Documentation

Full API reference: <https://alexkroman.github.io/agent/>
