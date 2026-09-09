---
title: Tools
description: A tool is a file in tools/. The filename is the name the model calls it by.
---

A tool is an ordinary function the model can decide to call. It lives in
`tools/`, and the filename is its name:

```ts
// tools/get_store_hours.ts
// The model calls this `get_store_hours`.
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

const HOURS: Record<string, string> = {
  denver: "9am to 7pm",
  austin: "10am to 6pm",
};

export default tool({
  description: "Get today's opening hours for one of our stores",
  inputSchema: z.object({ city: z.string().describe("City name, e.g. Denver") }),
  execute: ({ city }) => ({ city, hours: HOURS[city.toLowerCase()] ?? "closed today" }),
});
```

Three fields:

- **`description`** — how the model decides whether to call it. This is the
  most important string in the file.
- **`inputSchema`** — a Zod object. Omit it for a tool that takes no arguments.
  `.describe()` on a field is shown to the model, so use it.
- **`execute`** — sync or async. Return anything JSON-shaped; the model sees it.

There is nothing to register and no list to join. A file in `tools/` is a tool
because it is in `tools/`.

## Calling your own API

`execute` can call `fetch` directly, and it works the same in `aai dev` as it
does deployed. Its second argument, `ctx`, carries two things worth using from
the start:

```ts
// tools/get_order.ts
import { requireEnv, tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Look up one of the caller's orders",
  inputSchema: z.object({ id: z.string().describe("Order number") }),
  execute: async ({ id }, ctx) => {
    const res = await fetch(`https://api.example.com/orders/${id}`, {
      headers: { authorization: requireEnv(ctx, "ORDERS_API_KEY") },
      signal: ctx.signal,
    });
    const order = (await res.json()) as { status: string; eta: string };
    return { id, status: order.status, eta: order.eta };
  },
});
```

`ctx.env` holds the keys from your `.env` locally, and your agent's secrets in
production. `requireEnv(ctx, "KEY")` fails by name instead of sending
`undefined` into a header.

`ctx.signal` aborts when the caller interrupts or the call ends. Pass it to
anything slow, so a request nobody is waiting for stops instead of being waited
out. It is always present, so no `?.` is needed.

The rest of `ctx` — conversation history, one-shot model calls, subagents,
pushing events to the browser, starting background runs — is in the
[SDK reference](/agent/reference/).

## Return only the fields the answer needs

Whatever you return is serialized into the conversation and re-sent to the
model on every later turn of the call. So `return await res.json()` leaves an
entire API response in the prompt for the rest of the call: slower, more
expensive, and more for the model to misread. A result over 4000 characters is
warned about once per tool in the server log.

## When a tool fails

Return the failure instead of throwing it. `toolFailure` gives the model a
sentence it can say out loud, and the conversation carries on:

```ts
// tools/get_order.ts
import { tool, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Look up one of the caller's orders",
  inputSchema: z.object({ id: z.string().describe("Order number") }),
  execute: async ({ id }, ctx) => {
    const url = `https://api.example.com/orders/${id}`;
    const res = await fetch(url, { signal: ctx.signal });
    if (!res.ok) return toolFailure(`I couldn't look up order ${id} just now.`);
    const order = (await res.json()) as { status: string };
    return { id, status: order.status };
  },
});
```

Throwing is not silent: the runtime hands the model the error message as that
call's result. But then a bug in your code and "no such order" look the same to
it, and it will keep trying. Returning a failure is how you say which one
happened.

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

Two things you get without configuring them: "the second one" picks by
position, ahead of any word matching, and a tie between two candidates asks
rather than guessing.

### The three ways to match

Declare whichever apply. They can be combined.

**`code` — an identifier the caller reads back.** An order number, a booking
reference, an id. Spacing, punctuation and case are stripped from both sides,
so "order w-071", "order W 071" and "W 0 7 1" all find `W071`. It is tried
before the position and before the words: a caller who reads an id out has
named exactly one thing.

:::caution[Digits spoken as words are not converted]
"order W zero seven one" does not find `W071` — nothing turns `zero` into `0`.
A code shorter than four characters after that stripping is ignored too,
because containment in a whole utterance would match by accident.
:::

**`match` — the candidate's own words.** "the Northwind invoice", "Priya".
Every word of three or more characters the caller also said scores one point,
so a candidate matching more words wins. Shorter words never score, so "Ng"
does not find `Ida Ng`. A word two candidates share is a tie, and a tie asks.

**`score` — your own scorer.** For domain knowledge the other two can't
express. Its result is added to `match`'s score, so it can break a tie the
words leave.

## Next

- [Remembering things](/agent/build/state/) — state across tool calls
- [Testing](/agent/build/testing/) — a tool is a plain function, so test it
  like one
