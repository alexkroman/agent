// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:dialog` epoch 5.
 *
 * Epoch 6 added ONE optional field, `DialogStateSpec.persona`, and the
 * matching `DialogPosition.persona` read — a state may PIN who is speaking to
 * one of the agent's `personas`. Nothing an epoch-5 author wrote moved to reach
 * it: a dialog that names no persona compiles as it did, its stored snapshot is
 * byte-identical (a pin rides in the machine's `meta`, which is definition
 * rather than snapshot), and every gated tool, deadline and voice knob below is
 * exactly what epoch 5 promised.
 *
 * ## It names every one of epoch 5's fifteen exports
 *
 * `v4.ts` already carries this capability's roll-call, so coverage does not
 * need a second one — this file names all fifteen anyway, because the claim it
 * makes is per NAME: a later epoch that renames or removes one reddens here as
 * well as there. The front half is a claim dialog an epoch-5 author would have
 * written, pinning no persona; the back half names the handle's and the spec's
 * types one by one.
 *
 * **Its specifiers are RELATIVE**, for the reason every frozen example's are:
 * importing the package by name would prove the CURRENT surface compiles rather
 * than that epoch 5's does.
 *
 * @module
 */

import { z } from "zod";

import type {
  AnyDialog,
  Dialog,
  DialogBargeIn,
  DialogEvent,
  DialogOptions,
  DialogPosition,
  DialogSessionEventName,
  DialogSpec,
  DialogStateSpec,
  DialogTimeout,
  DialogTimeoutSpec,
  DialogToolDef,
  DialogToolResult,
  DialogVoiceConfig,
  SlotHolder,
} from "../../../index.ts";
import { dialog } from "../../../index.ts";

/** The hang-up, as an epoch-5 `on` key spells a SESSION event. */
const hangUp: DialogSessionEventName = "@session.timed-out";

/** A disclosure that must finish — epoch 5's barge-in policy. */
const uninterruptible: DialogBargeIn = "off";

/** The deadline half an author DECLARES, before the runtime arms it. */
const giveUp: DialogTimeoutSpec = { afterMs: 120_000, send: "GAVE_UP" };

const spec = {
  initial: "verifying",
  states: {
    verifying: {
      instruction: "Get the caller's policy number.",
      timeout: giveUp,
      on: { VERIFIED: "disclosure", GAVE_UP: "abandoned", [hangUp]: "abandoned" },
    },
    disclosure: {
      instruction: "Read the excess disclosure in full.",
      voice: "michael",
      bargeIn: uninterruptible,
      toolChoice: "none",
      temperature: 0.2,
      on: { ACKNOWLEDGED: "quoting", [hangUp]: "abandoned" },
    },
    quoting: {
      instruction: "Quote, then take the answer.",
      on: { QUOTED: "done", [hangUp]: "abandoned" },
    },
    abandoned: { final: true },
    done: { final: true },
  },
} as const satisfies DialogSpec;

/** One state of it, as the plain-object type an author may annotate. */
export const disclosureState: DialogStateSpec = spec.states.disclosure;

const options: DialogOptions = { durable: true };

/** The dialog an epoch-5 author declared: a spec, and the durability option. */
export const claim = dialog("claim", spec, options);

/** Its event union, synthesized from the `on` keys. */
export type ClaimEvent = DialogEvent<typeof spec>;

/** The handle's type, spelled both ways an author reaches for it. */
export type ClaimDialog = Dialog<typeof claim.machine, ClaimEvent>;
export const anyDialog: AnyDialog = claim;

/** A gated tool, written as the def the handle takes. */
const quoteDef: DialogToolDef<
  z.ZodObject<{ excess: z.ZodNumber }>,
  { excess: number },
  ClaimEvent
> = {
  description: "Quote the premium once the disclosure has been read.",
  inputSchema: z.object({ excess: z.number() }),
  when: "quoting",
  send: { type: "QUOTED" },
  execute: ({ excess }) => ({ excess }),
};

export const quote = claim.tool(quoteDef);

/** What that tool answers: the author's result under the position it left. */
export type QuoteResult = DialogToolResult<{ excess: number }>;

/** The three reads an epoch-5 runtime or spec makes of a live dialog. */
export function whereIs(ctx: SlotHolder): DialogPosition {
  return claim.position(ctx);
}
export function deadline(ctx: SlotHolder): DialogTimeout | undefined {
  return claim.timeout(ctx);
}
export function knobs(ctx: SlotHolder): DialogVoiceConfig | undefined {
  return claim.voiceConfig(ctx);
}
