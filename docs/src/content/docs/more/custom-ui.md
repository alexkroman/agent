---
title: Your own UI
description: Every agent gets a voice UI for free. Replace a panel, or the page.
---

You do not need a `client.tsx`. Every agent gets a working browser voice client
without one.

Add the file and you get the same shell with your own panel:

```tsx
// client.tsx
import { mountClient, useAgentState } from "@alexkroman1/aai-ui";
import "@alexkroman1/aai-ui/styles.css";

type CartView = { count: number };

function CartPanel() {
  // Server state, projected by the agent's `syncState` after every tool call.
  const cart = useAgentState<CartView>({ count: 0 });
  return <p>{cart.count} items</p>;
}

mountClient({ sidebar: CartPanel });
```

`aai dev` builds it, and `aai publish` ships it, with no extra step.

## The hooks

| Hook | What it gives you |
| --- | --- |
| `useAgentState(fallback)` | Whatever the agent's `syncState` projects |
| `useSession()` | Connection state and the transcript |
| `useUserTranscript()` | "Speech detected" separately from "first word back" |
| `useToolResult(name, cb)` | A card per tool call |
| `useEvent(name, cb)` | Whatever a tool pushed with `ctx.send` |

`useUserTranscript` distinguishing those two is not a detail — a live caption
is a beat late if you collapse them.

For a non-React client, `createBrowserSession()` is the same session as a plain
store. Components, styling, and the full hook surface are in the
[SDK reference](/agent/reference/) under `@alexkroman1/aai-ui`.
