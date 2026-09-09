---
title: Remembering things
description: Session state that survives concurrent tool calls, a crash, and a redeploy.
---

To remember something across a conversation, declare a `sessionSlot`. One
declaration holds the name, the starting value, and the type — and unlike a
module-level variable it is safe when tools run concurrently:

```ts
// shared.ts
// The one place the shape is written down.
import { sessionSlot } from "@alexkroman1/aai";

export type Item = { sku: string; qty: number };

export const cartSlot = sessionSlot("cart", () => ({
  items: [] as Item[],
}));
```

Then a tool **reads** it with `slot.tool()`:

```ts no-check
// tools/list_cart.ts
import { cartSlot } from "../shared.ts";

export default cartSlot.tool({
  description: "List what's in the cart",
  // `cart` is typed from the slot's default — no annotation needed.
  execute: (_args, cart) => cart.items,
});
```

…and **writes** it with `slot.updateTool()`, by mutating what it is handed:

```ts no-check
// tools/add_to_cart.ts
import { z } from "zod";
import { cartSlot } from "../shared.ts";

export default cartSlot.updateTool({
  description: "Add an item to the cart",
  inputSchema: z.object({ sku: z.string(), qty: z.number() }),
  execute: ({ sku, qty }, cart) => {
    cart.items.push({ sku, qty });
    return { count: cart.items.length };
  },
});
```

There is nothing to declare on `agent()`. The slot owns its own default.

## Four rules

- **`tool` reads, `updateTool` writes.** A read gets a frozen copy, so
  mutating it throws instead of silently doing nothing.
- **An `updateTool` body cannot `await`.** Whatever it leaves on the draft is
  stored the moment it returns, which is what keeps two tools from overwriting
  each other. If you need to fetch something first, use a plain `tool()` — its
  `execute` gets `ctx` as a second argument — and call `slot.update(ctx, …)`.
- **Hold plain data.** Objects, arrays, strings, numbers, booleans, null. A
  `Map`, `Set`, `Date`, or class instance is refused with the field named,
  because none of them survives being stored.
- **It is stored for you.** On the platform, a crash or a redeploy no longer
  loses the cart. Under `aai dev` it lives in memory unless you point a
  `DATABASE_URL` at your own Postgres in `.env`. The code is the same either
  way, which is what the rules above buy.

## Showing it to the browser

`syncState` projects a slot to your own UI after every tool call:

```ts no-check
// agent.ts
import { agent } from "@alexkroman1/aai";
import { cartSlot } from "./shared.ts";

export default agent({
  name: "Store",
  syncState: cartSlot.projection((cart) => ({ count: cart.items.length })),
});
```

Read it with `useAgentState(cartSlot.projection(view))` in the browser — see
[Your own UI](/agent/more/custom-ui/). Without a `syncState` there is nothing
for that hook to receive.

## Next

- [Testing](/agent/build/testing/) — driving a slot from a spec
- [Background jobs](/agent/more/background-jobs/) — for work that outlives the call
