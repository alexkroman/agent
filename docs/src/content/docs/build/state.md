---
title: Remembering things
description: Session state that survives concurrent tool calls, a crash, and a redeploy.
---

A `sessionSlot` is how tools remember something across a conversation. One
declaration holds the name, the starting value, and the type. Unlike a
module-level variable, a slot is safe when two tools run at once.

## Declare the slot

```ts
// shared.ts
import { sessionSlot } from "@alexkroman1/aai";

export type Cart = { items: string[] };

export const cartSlot = sessionSlot("cart", (): Cart => ({ items: [] }));
```

There is nothing to declare on `agent()` — the slot owns its own default. The
`: Cart` annotation is what types it: an empty array cannot say on its own what
it will hold.

## Read it with `slot.tool()`

`execute` is handed the current value as its second argument, already typed
from the slot's default:

```ts no-check
// tools/list_cart.ts
import { cartSlot } from "../shared.ts";

export default cartSlot.tool({
  description: "List what's in the cart",
  execute: (_args, cart) => ({ items: cart.items }),
});
```

## Write to it with `slot.updateTool()`

Same shape, except the value you are handed is a mutable draft. Change it in
place; whatever you leave behind is stored:

```ts no-check
// tools/add_to_cart.ts
import { z } from "zod";
import { cartSlot } from "../shared.ts";

export default cartSlot.updateTool({
  description: "Add an item to the cart",
  inputSchema: z.object({ item: z.string() }),
  execute: ({ item }, cart) => {
    cart.items.push(item);
    return { count: cart.items.length };
  },
});
```

## Four rules

- **`tool` reads, `updateTool` writes.** What a `tool` is handed is readonly all
  the way down, so `cart.items.push(item)` inside one is a compile error rather
  than a write that silently goes nowhere.
- **Hold plain data.** Objects, arrays, strings, numbers, booleans, null. A
  `Map`, `Set`, `Date`, or class instance is refused with the field named,
  because none of them survives being stored.
- **An `updateTool` body cannot `await`.** Whatever it leaves on the draft is
  stored the moment it returns, and that is what keeps two concurrent tools
  from overwriting each other. To fetch something first, use a plain `tool()`:
  its `execute` gets `ctx` as a second argument, so it can call
  `cartSlot.update(ctx, …)` once the data is in hand.
- **It is stored for you.** On the platform, a crash or a redeploy no longer
  loses the cart. Under `aai dev` it lives in memory, unless you point a
  `DATABASE_URL` at your own Postgres in `.env`. The code is the same either
  way, which is what the three rules above buy.

## Showing it to the browser

Three steps: declare what the browser gets to see, push it, read it.

**1. Add a `view` to the slot.** It is the shape the browser receives, and the
slot carries it as `slot.projected`:

```ts
// shared.ts, again — the view belongs with the slot.
import { sessionSlot } from "@alexkroman1/aai";

export type Cart = { items: string[] };

export const cartSlot = sessionSlot("cart", (): Cart => ({ items: [] }), {
  view: (cart) => ({ count: cart.items.length }),
});
```

**2. Push it from the agent.** `syncState` sends a fresh frame after every tool
call:

```ts no-check
// agent.ts
import { agent } from "@alexkroman1/aai";
import { cartSlot } from "./shared.ts";

export default agent({ name: "Store", syncState: cartSlot.projected });
```

**3. Read it in the browser** with the same object:
`useAgentState(cartSlot.projected)`. No type argument, and no empty frame to
write by hand. See [Your own UI](/agent/more/custom-ui/).

:::note[No `syncState`, nothing to receive]
`useAgentState` only ever shows what an agent projects. An agent that declares
no `syncState` pushes nothing, and the hook has nothing to render.
:::

### Why both ends pass the same object

`cartSlot.projected` is built once, where the slot is declared. The agent
pushes with it and the page renders with it, so the frame shown before the
first tool call and the frames pushed after it cannot describe different views.

Writing out a view at each end separately is what could drift: two expressions
have to agree, and nothing checks that they do.

### Showing one slot two ways

`syncState` also takes an array, so one slot can be projected more than once —
its declared view for one panel, a different view for another. Build the extra
projections with `slot.projection(view)`:

```ts
import { agent, sessionSlot } from "@alexkroman1/aai";

type Cart = { items: string[] };

const cartSlot = sessionSlot("cart", (): Cart => ({ items: [] }), {
  view: (cart) => ({ count: cart.items.length }),
});

export default agent({
  name: "Store",
  syncState: [
    cartSlot.projected, // { count }
    cartSlot.projection((cart) => ({ items: [...cart.items] })),
  ],
});
```

## Next

- [Testing](/agent/build/testing/) — driving a slot from a spec
- [Background jobs](/agent/more/background-jobs/) — for work that outlives the call
