// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:dialog` epoch 14.
 *
 * A support line's call flow — the statechart form of the four paragraphs of
 * system prompt that used to say "verify the caller BEFORE you look anything
 * up". The spec declares where a call may go next, each state carries the
 * instruction for the step in front of the agent, and the four tools are gated
 * on it: out of state the body does not run and the model is told where the
 * conversation actually is. Written the way it was authored at epoch 14, and it
 * must keep compiling for as long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 14 survives it
 *
 * Nothing this capability exports. `aai:dialog`'s list is byte-identical across
 * the bump — `dialog`, `Dialog`, `DialogOptions`, `DialogPosition`,
 * `DialogSpec`, `DialogStateSpec`, `DialogEvent`, `DialogToolDef`,
 * `DialogToolResult` — and the report hash moved because `WorkflowBody`'s second
 * parameter type was renamed `WorkflowCtx` -> `WorkflowContext`.
 *
 * **This example never touches a workflow at all, which is the cleanest reason
 * available.** The renamed type is in the rollup only because
 * {@link DialogToolDef}'s `execute` takes a `ToolContext`, and a `ToolContext`
 * has a `workflows` member whose client mentions a `WorkflowDef`, whose body is
 * a `WorkflowBody`. A dialog is about what the CONVERSATION may do next, and
 * durable runs are somewhere else entirely: the four bodies below read
 * `ctx.env` and `ctx.sessionId`, and that is the whole of their use of the
 * context. There is no name here for the rename to reach.
 *
 * **The directions that WOULD break this file** are the ones this capability's
 * own shape turns on. {@link DialogPosition} losing `instruction` — the field a
 * refusal quotes and every gated result carries, and the reason
 * {@link callHint} can answer "what now" without the spec. `when` narrowing from
 * `string | readonly string[]` to a single state, which {@link callStatus}
 * depends on. `sendFrom` losing its `Exclude<…, ToolFailure>`, which is what
 * lets {@link escalateDef}'s narrowing read a plain property off a body that can
 * fail. Or `tool()` going back to answering a bare `ToolDef<P>`, which is what
 * makes {@link EscalationResult} derivable at all.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 14 has to be dropped with a reason.
 */

import { z } from "zod";
import {
  type Dialog,
  type DialogEvent,
  type DialogOptions,
  type DialogPosition,
  type DialogSpec,
  type DialogStateSpec,
  type DialogToolDef,
  type DialogToolResult,
  dialog,
  type InferToolOutput,
  requireEnv,
  type SlotHolder,
  type StateProjection,
  toolFailure,
} from "../../../index.ts";

/**
 * ── EDIT: where a call may go next. ──────────────────────────────────────
 *
 * `as const` is load-bearing: it keeps the `on` keys literal, so
 * {@link DialogEvent} synthesizes the event union from them and a misspelled
 * `send` is a compile error rather than an event XState quietly ignores.
 *
 * `RESOLVED` is declared on the `working` PARENT so both children inherit it —
 * a call can be resolved while it is being escalated, and repeating the
 * transition in each child is how the two eventually disagree. That is also why
 * `working` is a parent at all: what every gated tool needs is "the caller is
 * verified", and the children exist to carry the instruction for the step the
 * agent is actually on.
 */
const callSpec = {
  initial: "greeting",
  states: {
    greeting: {
      instruction:
        "You have not verified who this is. Ask for the account number and the " +
        "postcode on the account, then call verify_caller. Look nothing up until it " +
        "comes back verified.",
      on: { VERIFIED: "working" },
    },
    working: {
      initial: "diagnosing",
      on: { RESOLVED: "closed" },
      states: {
        diagnosing: {
          instruction:
            "Verified. Work out what is wrong — ask what they see, in their words — " +
            "and fix it if you can. Escalate only once you can say what you tried.",
          on: { ESCALATED: "escalating" },
        },
        escalating: {
          instruction:
            "An engineer is on it. Tell the caller what was raised and the reference, " +
            "and stay on the line until they have it written down.",
        },
      },
    },
    closed: {
      instruction: "The call is finished. Say goodbye; do not start anything new.",
      final: true,
    },
  },
} as const satisfies DialogSpec;

/**
 * One state, named — what a module that generates or reviews states declares.
 *
 * The type exists because the field it checks fails SILENTLY: an instruction
 * spelled `instructions`, or nested one level off, used to compile and deploy
 * and produce refusals carrying no recovery text at all.
 */
export const escalatingState: DialogStateSpec = callSpec.states.working.states.escalating;

/** Stored durably, stated: a call that survives a redeploy mid-conversation
 *  must not come back at `greeting` and ask for the account number again. */
const callOptions: DialogOptions = { durable: true };

/**
 * The flow. Its own slot key, and nothing else may take it — not another
 * dialog, and not a `sessionSlot`.
 */
export const callFlow = dialog("call", callSpec, callOptions);

/** Every event this spec declares, derived from the `on` maps rather than
 *  restated beside them. */
export type CallEvent = DialogEvent<typeof callSpec>;

/**
 * The flow as a parameter type.
 *
 * `Dialog` is generic over the MACHINE, and a spec-declared dialog builds one
 * whose type carries no events — hence the second parameter. Naming the machine
 * as `typeof callFlow.machine` is what keeps this spelling free of an XState
 * import, which an agent that declared its dialog as a spec should not need.
 */
export type CallFlow = Dialog<typeof callFlow.machine, CallEvent>;

/**
 * ── EDIT: what the agent is supposed to be doing right now. ──────────────
 *
 * The instruction comes off the position rather than out of a lookup table
 * here, which is the point of declaring it on the state: one source, quoted by
 * a refusal, carried on every gated tool's result, and readable by an event
 * handler like this one.
 */
export function callHint(position: DialogPosition): string {
  if (position.done) return "The call is closed.";
  return position.instruction ?? `The call is at ${position.state}.`;
}

/** Where this session's call is, for a helper that is not in a tool — a slot
 *  holder is all any dialog method takes. */
export function callAt(holder: SlotHolder): DialogPosition {
  return callFlow.position(holder);
}

/** Whether the caller has been verified, as the tools' own gate spells it. */
export function isVerified(holder: SlotHolder): boolean {
  return callFlow.matches(holder, "working");
}

/**
 * Verify the caller, and let the call move on.
 *
 * `send` fires only on success — a body that returned a {@link ToolFailure} did
 * not do the thing, and a dialog that advanced anyway would leave every later
 * gate wrong.
 */
export const verifyCaller = callFlow.tool({
  description: "Verify the caller against the account number and postcode they gave.",
  when: "greeting",
  inputSchema: z.object({
    accountNumber: z.string().max(24),
    postcode: z.string().max(12),
  }),
  send: { type: "VERIFIED" },
  execute: async ({ accountNumber, postcode }, ctx) => {
    const response = await fetch(`https://crm.example.com/v1/accounts/${accountNumber}`, {
      headers: { authorization: `Bearer ${requireEnv(ctx, "CRM_API_KEY")}` },
      signal: ctx.signal,
    });
    if (!response.ok) return toolFailure("The account system is not answering. Try again.");
    const account = (await response.json()) as { postcode: string; name: string };
    if (account.postcode.toUpperCase() !== postcode.toUpperCase()) {
      return toolFailure("That postcode does not match the account. Ask them to read it again.");
    }
    return { name: account.name, verified: true };
  },
});

/** What an escalation answers with — declared, because the def below is
 *  annotated and an annotation needs a name for its `R`. */
export interface Escalation {
  reference: string;
  /** Absent when nothing could be raised, which is a result rather than a
   *  failure: the caller still needs to be told. */
  queued: boolean;
}

/**
 * ── EDIT: the tool whose OUTCOME picks the transition. ───────────────────
 *
 * Declared as an annotated {@link DialogToolDef} rather than inline, and that is
 * worth copying for any tool with a `sendFrom`: with `R` fixed by the
 * annotation, the narrowing means the same thing wherever the field is written,
 * where an inline literal's `R` is decided by source order and a `sendFrom`
 * above `execute` reads its result as untyped.
 *
 * `sendFrom` is handed the SUCCESS value — the failure check returns before it
 * runs — so `result.queued` is a plain property read rather than a second
 * narrowing of a case that cannot arrive.
 */
const escalateDef: DialogToolDef<
  z.ZodObject<{ summary: z.ZodString; tried: z.ZodString }>,
  Escalation,
  CallEvent
> = {
  description: "Raise the fault with an engineer. Use once you can say what you tried.",
  when: "working.diagnosing",
  inputSchema: z.object({
    summary: z.string().max(400),
    tried: z.string().max(400).describe("What you already tried, so it is not repeated"),
  }),
  execute: ({ summary, tried }, ctx) => ({
    reference: `ESC-${ctx.sessionId.slice(0, 6)}`,
    queued: summary.length > 0 && tried.length > 0,
  }),
  // Only when something was actually raised. A refused escalation leaves the
  // call where it is, which is not a failure but is not progress either.
  sendFrom: (result) => (result.queued ? { type: "ESCALATED" } : undefined),
};

export const escalate = callFlow.tool(escalateDef);

/**
 * What the client renders for an escalation.
 *
 * The wrapped envelope is the tool's real return type — the body's own value
 * under `result`, plus the position the call landed in — so a custom client
 * derives it instead of restating it, and a page that reads `result.reference`
 * cannot drift from what the tool sends.
 */
export type EscalationResult = InferToolOutput<typeof escalate>;

/** The unwrapped half, for a renderer that has already checked the envelope. */
export type EscalationEnvelope = DialogToolResult<Escalation>;

/**
 * A read that advances nothing.
 *
 * No `send` and no `sendFrom`, which is legal and is what a status tool wants;
 * `when` takes the LIST so it is callable from either child of `working`.
 */
export const callStatus = callFlow.tool({
  description: "Say where this call has got to and what is outstanding.",
  when: ["working.diagnosing", "working.escalating"],
  execute: (_args, ctx) => ({ session: ctx.sessionId }),
});

/** Close the call. Gated on the parent, so it is reachable from both children. */
export const closeCall = callFlow.tool({
  description: "Close the call once the caller says they are happy.",
  when: "working",
  send: { type: "RESOLVED" },
  execute: () => ({ closed: true }),
});

/** ── EDIT: what the browser shows about the call. ──────────────────────── */
export interface CallStep {
  step: string;
  hint: string;
  done: boolean;
}

/**
 * The position, projected for the client.
 *
 * The projector is required for the reason a slot's is: an optional one could
 * only be typed by asserting that the raw {@link DialogPosition} is the caller's
 * own view. Project the identity to push the whole thing.
 */
export const callProjection: StateProjection<CallStep> = callFlow.projection((position) => ({
  step: position.state,
  hint: callHint(position),
  done: position.done,
}));

/** Start the call over — a transfer back to the front of the queue. */
export function restartCall(holder: SlotHolder): DialogPosition {
  return callFlow.reset(holder);
}
