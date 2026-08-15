// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 10.
 *
 * Epoch 10 removed the agent's state SHAPE — the `state` factory, the type
 * parameter it was the only source of, and `InferAgentState`. A session's state
 * belongs to a `sessionSlot`, which types and stores its own value in the module
 * that declares it, so there is nothing per-agent left to thread.
 *
 * What an author writes instead is here: no `state`, and `syncState` takes that
 * slot's projection rather than a function over the whole bag. The slot's own
 * factory is what makes a session that has run no tool projectable, which is the
 * job the forgotten-four-times-out-of-five `state` declaration used to have.
 *
 * See `./v3.ts` for what "frozen" obliges and why the imports are relative.
 */

import { agent, sessionSlot } from "../../../index.ts";

type Cart = { items: string[]; staffPin: string };

const cartSlot = sessionSlot("cart", (): Cart => ({ items: [], staffPin: "" }));

export default agent({
  name: "Shop",
  greeting: "What can I get you?",
  // `staffPin` stays server-side: the projection is where an author decides what
  // leaves, which is why `syncState` takes one rather than a flag.
  syncState: cartSlot.projection((cart) => ({ count: cart.items.length })),
});

/** An agent that projects more than one slot: the frame carries the merge. */
const flagSlot = sessionSlot("flags", () => ({ seen: false }));

export const twoSlots = agent({
  name: "Two",
  syncState: [
    cartSlot.projection((cart) => ({ count: cart.items.length })),
    flagSlot.projection((flags) => ({ seen: flags.seen })),
  ],
});
