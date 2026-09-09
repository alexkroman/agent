---
title: Tools
description: A tool is a file in tools/. The filename is the name the model calls it by.
---

A tool is an ordinary async function the model can decide to call. It lives in
`tools/`, and the filename is its name:

```ts
// tools/get_weather.ts
// The model calls this `get_weather`.
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Get current weather for a city",
  inputSchema: z.object({ city: z.string().describe("City name") }),
  execute: async ({ city }) => {
    const where = encodeURIComponent(city);
    const res = await fetch(`https://wttr.in/${where}?format=j1`);
    const report = (await res.json()) as {
      current_condition?: { temp_F?: string; weatherDesc?: { value?: string }[] }[];
    };
    const now = report.current_condition?.[0];
    // Return what the agent will SAY, not the whole response.
    return { city, tempF: now?.temp_F, sky: now?.weatherDesc?.[0]?.value };
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

**Return only the few fields the answer needs**, not the whole API response.

:::caution[A big return value stays in the prompt]
Whatever you return is serialized into the conversation and re-sent to the
model on every later turn of the call. So `return await res.json()` leaves an
entire API response in the prompt for the rest of the call: slower, more
expensive, and more for the model to misread. A result over 4000 characters is
warned about once per tool in the server log.
:::

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
    const order = (await res.json()) as { status?: string; eta?: string };
    return { id, status: order.status, eta: order.eta };
  },
});
```

`ctx.env` holds the keys from your `.env` locally, and your agent secrets in
production. `requireEnv(ctx, "KEY")` fails by name instead of sending
`undefined` into a header.

`ctx.signal` aborts when the caller interrupts or the call ends. Forwarding it
stops work nobody is waiting for any more. It is always present, so no `?.` is
needed.

The rest of `ctx` — conversation history, one-shot model calls, subagents,
pushing events to the browser, starting background runs — is in the
[SDK reference](/agent/reference/).

## Matching what a caller said

Callers don't say ids. They say "cancel my second order" or "the blue medium
one". `resolveOne` picks the one they meant. When it can't tell, it hands the
model a message listing the choices so the agent can ask:

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
      // "order W071" — matched however the caller spaced or punctuated it.
      code: (o) => o.id,
    });
    // Ambiguous, or nothing matched → the model asks, instead of cancelling
    // the wrong order and apologizing afterwards.
    if (isToolFailure(order)) return order;
    return { cancelled: order.id };
  },
});
```

Two things you get without configuring them: "the second one" always wins, and
a tie between two candidates asks rather than guessing.

### The three ways to match

Declare whichever apply. They can be combined.

**`code` — an identifier the caller reads back.** An order number, a booking
reference, an id. Punctuation and case are stripped before comparing, so "order
W zero seven one" finds `W071`.

**`match` — the candidate's own words.** "the Northwind invoice", "Priya".
Every word the caller also said scores one point, so a candidate matching more
words wins. A word two candidates share is a tie, and a tie asks.

**`score` — your own scorer.** For domain knowledge the other two can't
express. Its result is added to `match`'s score, so it can break a tie the
words leave.

## Next

- [Remembering things](/agent/build/state/) — state across tool calls
- [Testing](/agent/build/testing/) — a tool is a plain function, so test it
  like one
