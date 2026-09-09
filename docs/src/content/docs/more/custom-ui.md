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
import { mountClient, useAgentState } from "@alexkroman1/aai-ui";
import "@alexkroman1/aai-ui/styles.css";

// Module scope, not inline in the render body — it has to be a stable
// reference across renders.
const EMPTY = { count: 0 };

function CartPanel() {
  const cart = useAgentState(EMPTY);
  return <p>{cart.count} items</p>;
}

mountClient({ sidebar: CartPanel });
```

`useAgentState` reads whatever the agent projects with `syncState` — declare
one first, or there is nothing to receive. When the slot declares a `view`, pass
`cartSlot.projected` instead of a fallback: it is the same object the agent
pushes with, so there is no empty frame to write and no type to restate. See
[Remembering things](/agent/build/state/).

`aai dev` builds it, and `aai publish` ships it, with no extra step.

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

Building a page for a [background job](/agent/more/background-jobs/) rather than
a conversation? That calls `mountPage()` instead of `mountClient()` — and its
`component` is optional the same way, so `mountPage({ name: "Digest" })` gets you
a form built from each workflow's own input schema, the run's progress, and its
result. Pass a `component` when you want to lay the result out yourself; the
pieces the default is made of (`useWorkflows`, `<WorkflowFields>`,
`useWorkflowSubmit`, `<WorkflowProgress>`, `<WorkflowRunError>`) are all
exported, so replacing the shell is not starting over.
