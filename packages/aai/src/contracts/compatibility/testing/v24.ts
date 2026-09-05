// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 24.
 *
 * A tool spec as it was written at epoch 24 — `createToolContext` standing in
 * for the session a deployed tool would get, and the slot helpers reading back
 * what the body wrote. It must keep compiling for as long as that epoch is
 * advertised as supported.
 *
 * ## What moved, and why epoch 24 survives it
 *
 * Nothing this capability's own surface exports. `aai:testing`'s report moved
 * because {@link AgentDef} appears in its rollup — `createToolContext` is
 * written against the same definitions a deployed agent is — and `AgentDef`
 * gained one OPTIONAL field, `dialogs`, plus the `AnyDialog` its element type
 * needs.
 *
 * **This example never declares an agent at all, which is the cleanest reason
 * available.** It builds a context and calls a tool with it, which is what the
 * testing capability is FOR; `AgentDef` is in the rollup transitively and is
 * not part of what an author writes here. A field added to a type this file
 * only reaches through inference cannot reach this file.
 *
 * **The directions that WOULD break it**: `createToolContext` requiring a
 * field it currently defaults (it admits an explicit `undefined` per field,
 * which is what removed the `...(x ? { x } : {})` dance specs used to write
 * around an optional `sessionId`); `ToolContext` losing `slots`, which is how a
 * tool reaches session state at all; or a slot's `get` ceasing to return a
 * `DeepReadonly`, which is what makes a read that mutates a compile error
 * rather than a bug found in production.
 */

import { z } from "zod";
import { sessionSlot, tool } from "../../../index.ts";
import { createToolContext } from "../../../sdk/testing.ts";

/** What the call under test accumulates. */
const trip = sessionSlot("trip-v24", () => ({ stops: [] as string[] }));

/** The tool a spec drives directly. */
export const addStop = tool({
  description: "Add a stop to the trip",
  inputSchema: z.object({ stop: z.string() }),
  execute: ({ stop }, ctx) =>
    trip.update(ctx, (draft) => {
      draft.stops.push(stop);
      return draft.stops.length;
    }),
});

/** The epoch-24 shape of a spec: build a context, run the body, read it back. */
export async function exerciseAddStop(): Promise<{ count: unknown; stops: readonly string[] }> {
  const ctx = createToolContext({ sessionId: "s-1" });
  const count = await addStop.execute?.({ stop: "mile 40" }, ctx);
  return { count, stops: trip.get(ctx).stops };
}
