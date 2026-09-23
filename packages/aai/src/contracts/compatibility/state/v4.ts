// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:state` epoch 4.
 *
 * Epoch 5 changed nothing an epoch-4 slot tool wrote. `SlotToolDef` stopped
 * restating `ToolDef` field by field and became `Omit<ToolDef, "execute">` plus
 * the slot-threaded `execute`, which ADDS the one field the copy had missed —
 * `messages`, the agent's speech around the call — and keeps every field it
 * had. The compatibility probe cannot prove that on its own (two declarations
 * of a mapped `Omit` are unrelated to the checker), so this file is the proof.
 *
 * The promise: an epoch-4 slot tool — `description`, `inputSchema`, a
 * three-argument `execute`, `onError`, and no `messages` key — still compiles,
 * in both halves. The `SlotToolDef` annotation is the part a copy-shaped change
 * could have broken, so it is written out rather than inferred.
 *
 * Coverage is per capability over the union of frozen examples, and `v1.ts`
 * and `v2.ts` already name every export this one has — so this file is about
 * the transition rather than a roll-call. Its specifiers are RELATIVE, so it
 * proves epoch 4's surface compiles rather than the current build's.
 *
 * @module
 */

import { z } from "zod";

import type { DeepReadonly, SlotToolDef } from "../../../index.ts";
import { sessionSlot, toolFailure } from "../../../index.ts";

type Tab = { lines: { item: string; cents: number }[] };

const tabSlot = sessionSlot("tab", (): Tab => ({ lines: [] }));

const addLineSchema = z.object({ item: z.string(), cents: z.number().int() });

/** An epoch-4 def, annotated: the four fields the copied interface had. */
const addLine: SlotToolDef<typeof addLineSchema, Tab, { total: number }> = {
  description: "Add a line to the tab.",
  inputSchema: addLineSchema,
  execute: ({ item, cents }, tab) => {
    tab.lines.push({ item, cents });
    return { total: tab.lines.reduce((sum, line) => sum + line.cents, 0) };
  },
  onError: () => toolFailure("I couldn't update the tab just now."),
};

export const addToTab = tabSlot.updateTool(addLine);

/** The reading half, with the value handed over deep-frozen. */
export const tabTotal = tabSlot.tool({
  description: "Say what the tab comes to.",
  execute: (_args, tab: DeepReadonly<Tab>) => ({
    total: tab.lines.reduce((sum, line) => sum + line.cents, 0),
  }),
});
