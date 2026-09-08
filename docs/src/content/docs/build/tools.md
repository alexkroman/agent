---
title: Tools
description: A tool is a file in tools/. The filename is the name the model calls it by.
---

A tool is an ordinary async function the model can decide to call. It lives in
`tools/`, and the filename is its name:

```ts
// tools/get_weather.ts → the model calls this `get_weather`
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Get current weather for a city",
  inputSchema: z.object({ city: z.string().describe("City name") }),
  execute: async ({ city }) => {
    const where = encodeURIComponent(city);
    const res = await fetch(`https://wttr.in/${where}?format=j1`);
    return await res.json();
  },
});
```

Three fields:

- **`description`** — how the model decides whether to call it. This is the
  most important string in the file.
- **`inputSchema`** — a Zod object. Omit it for a tool that takes no arguments.
  `.describe()` on a field is shown to the model, so use it.
- **`execute`** — sync or async. Return anything JSON-shaped; the model sees it.

`execute` can call `fetch` directly, and it works the same in `aai dev` as it
does deployed.

## Secrets and cancellation

`execute` gets a second argument, `ctx`. Two parts of it matter early:

```ts
import { requireEnv, tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Look up an order",
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }, ctx) => {
    const res = await fetch(`https://api.example.com/orders/${id}`, {
      headers: { authorization: requireEnv(ctx, "ORDERS_API_KEY") },
      // Pass this to anything slow. It aborts when the caller interrupts.
      signal: ctx.signal,
    });
    return await res.json();
  },
});
```

`ctx.env` holds the keys from your `.env` locally and your agent secrets in
production. `requireEnv(ctx, "KEY")` fails by name instead of sending
`undefined` into a header.

`ctx.signal` aborts on barge-in, on reset, and on session stop. Forwarding it
is what makes a tool stop work the caller has already moved on from. It is
always present — no `?.` needed.

The rest of `ctx` — conversation history, one-shot model calls, subagents,
pushing events to the browser, starting background runs — is in the
[SDK reference](/agent/reference/).

## Matching what a caller said

Tool arguments don't arrive as ids over a phone line. They arrive as "cancel my
second order", "the blue medium one", "eight six four two". `resolveOne` picks
one candidate, or fails in the one shape a model can recover from on its own
turn — a message listing the choices:

```ts
import { isToolFailure, resolveOne, tool } from "@alexkroman1/aai";
import { z } from "zod";

const pending = [
  { id: "W004", total: "$120.00" },
  { id: "W071", total: "$38.50" },
];

export default tool({
  description: "Cancel one of the caller's pending orders",
  inputSchema: z.object({
    spoken: z.string().describe("What the caller said"),
  }),
  execute: ({ spoken }) => {
    const order = resolveOne(pending, spoken, {
      label: "pending order",
      describe: (o) => `${o.id} for ${o.total}`,
      score: (o, text) => (text.includes(o.id.toLowerCase()) ? 1 : 0),
    });
    // Ambiguous, or nothing matched → the model asks, instead of cancelling
    // the wrong order and apologizing afterwards.
    if (isToolFailure(order)) return order;
    return { cancelled: order.id };
  },
});
```

A caller who counts ("the second one") is unambiguous even when nothing else
matches, so a position wins outright. A scoring tie *fails* rather than
guessing.

## Next

- [Remembering things](/agent/build/state/) — state across tool calls
- [Testing](/agent/build/testing/) — tools are plain functions, so test them like any
