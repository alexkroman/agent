// Copyright 2026 the AAI authors. MIT license.
/**
 * What the ACTIVE PERSONA asks of each `streamText` step, as the pipeline
 * applies it — the sibling of `pipeline-dialog-knobs.ts`, one scope up.
 *
 * A persona may declare the two model knobs a dialog state may also declare,
 * `toolChoice` and `temperature`. They arrive as ONE `prepareStep` preparer,
 * per STEP rather than per turn, for the reason the dialog's do: a handoff
 * happens INSIDE a tool call, so the step after it is already the next
 * persona's and should run under that persona's settings — the same turn
 * continues as the new speaker, which is the whole point of a handoff over a
 * transfer.
 *
 * ## A persona's tools stay ADVERTISED, and that was measured rather than chosen
 *
 * The obvious extra is `activeTools`: narrow each step's tool list to the
 * active persona's own, so the model is not even offered billing's tools while
 * triage speaks. It is deliberately NOT done, and the reason is the one
 * `sdk/dialog.ts` gives for gating at execution rather than at advertisement,
 * plus a fact about the AI SDK found by trying it. `filterActiveTools` is
 * applied to the EXECUTION set as well as to what the model is sent, so a call
 * naming a hidden tool — a model that still reaches for it, a repaired call, a
 * scripted eval — is a `NoSuchToolError` the pipeline reports as an invalid
 * call with no `tool.completed`, never a result. The persona gate's refusal
 * ("`lookup_invoice` belongs to the billing persona, and triage is speaking;
 * hand off first") is a result the model READS and can act on, and narrowing
 * would have put a generic error in front of it. So the gate the SDK wraps
 * every persona tool in is the one enforcement point, identical on all three
 * transports, and the model keeps the list — exactly as it does for a dialog's
 * gated tools.
 *
 * ## Scope order: agent → persona → dialog state → forced final step
 *
 * `ToolChoice`'s documented precedence gains one rung. A persona is broader
 * than a dialog state — it is who is speaking, and the state is where in their
 * script they are — so the persona's knobs beat the agent's and lose to the
 * active dialog state's. `pipeline-llm-stream.ts` composes the preparers in
 * exactly that order.
 */

import type { ToolChoice } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { PrepareStepFunction, ToolSet } from "ai";

/**
 * What the active persona asks of THIS step. Every field is optional and an
 * absent one leaves the agent's own setting alone.
 *
 * @internal
 */
export interface PersonaTurnKnobs {
  /** The active persona's tool-selection policy, when it declares one. */
  toolChoice?: ToolChoice | undefined;
  /** The active persona's sampling temperature, when it declares one. */
  temperature?: number | undefined;
}

/**
 * Where the transport reads them from: a thunk, resolved fresh at each step.
 *
 * A THUNK for the reason `DialogTurnSource` is one — a handoff moves the
 * persona between reads, and a value captured at construction would pin the
 * call to whoever answered the phone. `undefined` means the agent declares no
 * roster, or a roster whose personas carry no knob a request can apply.
 *
 * @internal
 */
export type PersonaTurnSource = () => PersonaTurnKnobs | undefined;

/**
 * The preparer, or `undefined` when there is nothing to prepare.
 *
 * The `undefined` is load-bearing twice, as `dialogStep`'s is: it keeps a
 * roster whose personas differ only in prose and tools from putting a preparer
 * in front of every step, and it is what the transport gates PREEMPTIVE
 * GENERATION on — a speculation is assembled from the session's own knobs, so
 * a persona that moves one would make every speculation a mismatch.
 *
 * @internal
 */
export function createPersonaStep(
  source: PersonaTurnSource | undefined,
): PrepareStepFunction<ToolSet> | undefined {
  if (source === undefined) return undefined;
  return () => {
    const knobs = source();
    const step = omitUndefined({
      toolChoice: knobs?.toolChoice,
      temperature: knobs?.temperature,
    });
    // `undefined` rather than `{}` when the persona asks nothing of this step,
    // so it is prepared by exactly the preparers that shipped before this
    // existed — `composePrepareStep` treats both as "no keys", but only one of
    // them says so at the call site.
    return Object.keys(step).length === 0 ? undefined : step;
  };
}
