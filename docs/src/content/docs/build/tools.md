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

**Shape the result.** Whatever you return is serialized into the conversation
and re-sent to the model on every later turn of the call, so returning
`await res.json()` puts a whole API response in the prompt for the rest of the
turn — slower, more expensive, and more for the model to misread. Return the
few fields the answer needs. A result over 4000 characters is warned about once
per tool in the server log.

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

`ctx.signal` aborts when the caller interrupts or the call ends. Forwarding
it stops work nobody is waiting for any more. It is always present, so no
`?.` is needed.

The rest of `ctx` — conversation history, one-shot model calls, subagents,
pushing events to the browser, starting background runs — is in the
[SDK reference](/agent/reference/).

## Matching what a caller said

Callers don't say ids. They say "cancel my second order" or "the blue medium
one". `resolveOne` picks the one they meant, or — when it can't tell — hands
the model a message listing the choices so it can ask:

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

"The second one" always wins. A tie between two candidates asks rather than
guessing.

Three ways to say which one, and you can declare more than one:

- **`code`** — an id, a booking reference, an order number. Compared with the
  punctuation and case stripped, so "order W zero seven one" finds `W071`.
- **`match`** — the candidate's own words ("the Northwind invoice", "Priya").
  Every word the caller also said scores one, so more words win and a word two
  candidates share asks instead of picking.
- **`score`** — your own scorer, for the domain knowledge neither of those
  holds. It adds to `match`, so it can break a tie the words leave.

## Next

- [Remembering things](/agent/build/state/) — state across tool calls
- [Testing](/agent/build/testing/) — a tool is a plain function, so test it
  like one
