---
title: Your own UI
description: Every agent gets a voice UI for free. Replace a panel, or the page.
---

You do not need a `client.tsx`. Every agent gets a working browser page without
one — a voice client for a voice agent, and a form per declared workflow for a
[workflow app](/agent/more/background-jobs/).

Add the file and you get the same shell with your own panel:

```tsx
// client.tsx
import { sessionSlot } from "@alexkroman1/aai";
import { mountClient, useAgentState } from "@alexkroman1/aai-ui";
import "@alexkroman1/aai-ui/styles.css";

// In your project this is one line — `import { cartSlot } from "./shared.ts"`.
// The slot is declared once, beside the agent, and both ends read the same
// object.
type Cart = { items: { sku: string; qty: number }[] };
const cartSlot = sessionSlot("cart", (): Cart => ({ items: [] }), {
  view: (cart) => ({ count: cart.items.length }),
});

function CartPanel() {
  const cart = useAgentState(cartSlot.projected);
  return <p>{cart.count} items</p>;
}

mountClient({ sidebar: CartPanel });
```

`aai dev` builds it, and `aai publish` ships it, with no extra step.

`useAgentState` reads whatever the agent projects with `syncState`. Declare a
slot first, or there is nothing to receive — see
[Remembering things](/agent/build/state/).

:::note[No slot to hand?]
A page that cannot import the slot — a client kept apart from the agent — passes
a fallback object instead: `useAgentState(EMPTY)`, declared at module scope so
the reference is stable across renders. Reach for the slot whenever you have
it: `cartSlot.projected` is the same object the agent pushes with, so there is
no empty frame to write and no type to restate.
:::

## The hooks

| Hook | What it gives you |
| --- | --- |
| `useAgentState(slot.projected)` | Whatever the agent's `syncState` projects — typed and defaulted by the same projection |
| `useSession()` | Connection state and the transcript |
| `useUserTranscript()` | "Speech detected" separately from "first word back" |
| `useToolResult(name, cb)` | A card per tool call |
| `useEvent(name, cb)` | Whatever a tool pushed with `ctx.send` |

For a non-React client, `createBrowserSession({ platformUrl })` is the same
session as a plain store. Components, styling, and the full hook surface are in
the [SDK reference](/agent/reference/) under `@alexkroman1/aai-ui`.

## A page for a background job

Building a page for a [background job](/agent/more/background-jobs/) rather than
a conversation? That calls `mountPage()` instead of `mountClient()`.

Its `component` is optional the same way. `mountPage({ name: "Digest" })` gets
you a form built from each workflow's own input schema, the run's progress, and
its result.

Pass a `component` when you want to lay the result out yourself. The pieces the
default is made of — `useWorkflows`, `<WorkflowFields>`, `useWorkflowSubmit`,
`<WorkflowProgress>`, `<WorkflowRunError>` — are all exported, so replacing the
shell is not starting over.
