// Copyright 2026 the AAI authors. MIT license.
/**
 * FROZEN authoring example — `aai:dialog`, epoch 4.
 *
 * Moved with the `AgentParams` split (this capability's report is extracted
 * from the root rollup). Nothing in the dialog surface itself changed, and
 * epoch 4 is RETAINED: the declaration below is how a gated flow was written.
 * Do not edit it to make a compile error go away — the error IS the finding.
 */

import type { AnyStateMachine } from "xstate";
import { z } from "zod";
import { type Dialog, type DialogEvent, type DialogSpec, dialog } from "../../../index.ts";

const spec = {
  initial: "verifying",
  states: {
    verifying: { on: { VERIFIED: "quoting" } },
    quoting: { on: { QUOTED: "settled" } },
    settled: { final: true },
  },
} as const satisfies DialogSpec;

/** A spec-declared flow. The event union is DERIVED from the spec. */
export const flow: Dialog<AnyStateMachine, DialogEvent<typeof spec>> = dialog("checkout", spec);

/** Two tools gated on its states, each advancing the machine on success. */
export const verify = flow.tool({
  description: "Verify the caller",
  when: "verifying",
  inputSchema: z.object({ pin: z.string() }),
  send: { type: "VERIFIED" },
  execute: ({ pin }) => ({ ok: pin.length === 4 }),
});

export const quote = flow.tool({
  description: "Quote a price",
  when: "quoting",
  send: { type: "QUOTED" },
  execute: () => ({ price: 42 }),
});

/** The projection a dialog hands to `syncState`. */
export const position = flow.projection((at) => ({ state: at.state }));
