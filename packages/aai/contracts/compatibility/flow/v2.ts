// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:flow` epoch 2.
 *
 * Epoch 2 is the answer to what epoch 1 got wrong. A `flow()` stores its
 * position in a slot of its own, which makes it a SECOND source of truth beside
 * the data it is about — and the two are held in step by convention, every tool
 * moving both. What that costs is not a crash: a stale position produces a
 * refusal that READS CORRECT, naming a real state and quoting its real
 * instruction, so the model apologizes and retries something that cannot work.
 *
 * So epoch 2 adds two things, and an author picks between them:
 *
 * - **`derivedFlow(machine, slot, locate)`** — the position is a pure function
 *   of the slot, so there is nothing to keep in step. No `send`, no `sendFrom`,
 *   no `reset`: the write a tool body already makes IS the transition. Prefer
 *   this wherever the position is a function of the data, which in this repo was
 *   four templates out of five.
 * - **`FlowOptions.invariant`** — for the case that genuinely cannot derive,
 *   where the position carries history the data does not. It asserts the half
 *   that IS a function of the data, and `Flow.check` runs it on demand so a spec
 *   can assert agreement at the seam that breaks it.
 *
 * What this file therefore has to keep compiling: both factories, `locate` as a
 * total function of a frozen slot value, a gated tool with no transition field,
 * `DerivedFlow.projection`, the invariant's `(position, ctx)` shape, and
 * `UnknownFlowStateError` being catchable by name.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative. Editing this file to make a compile error go away defeats the
 * mechanism — the error IS the finding.
 */

import { setup } from "xstate";
import { z } from "zod";

import {
  type DerivedFlowToolDef,
  derivedFlow,
  type FlowPosition,
  flow,
  sessionSlot,
  toolFailure,
  UnknownFlowStateError,
} from "../../../index.ts";

// ── The derived flow: the position IS the data ───────────────────────────────

interface Call {
  customerId: string | null;
  transferred: boolean;
  notes: string[];
}

const callSlot = sessionSlot(
  "call",
  (): Call => ({ customerId: null, transferred: false, notes: [] }),
);

/**
 * A machine written for a derived flow. Its transitions are documentation — a
 * reader's and a visualizer's — because `locate` is what decides the position,
 * so an epoch-2 author may declare `on` blocks or none at all.
 */
const callMachine = setup({}).createMachine({
  id: "call",
  initial: "identifying",
  states: {
    identifying: { meta: { instruction: "Find out who this is before anything else." } },
    serving: {
      meta: { instruction: "Help this one customer, and say what you will change." },
      initial: "browsing",
      states: {
        browsing: { meta: { instruction: "Look things up; change nothing yet." } },
        closing: { type: "final", meta: { instruction: "Wrap the request up." } },
      },
    },
    transferred: { type: "final", meta: { instruction: "A human has the call now." } },
  },
});

export const callFlow = derivedFlow(callMachine, callSlot, (call) => {
  if (call.transferred) return "transferred";
  if (call.customerId === null) return "identifying";
  return call.notes.length > 0 ? "serving.closing" : "serving.browsing";
});

/**
 * `locate` is callable on its own — no context, no session, no tool call. That
 * is the property epoch 2 exists to buy, so it has to keep compiling: the
 * argument is the slot's DEEP-READONLY value, and a mutable value satisfies it.
 */
const located: string = callFlow.locate({
  customerId: "sara_doe_496",
  transferred: false,
  notes: [],
});

/** A nested final completes its region without ending the machine. */
export function readPosition(call: Call): { at: string; over: boolean; from: string } {
  const at = callFlow.locate(call);
  return { at, over: at === "transferred", from: located };
}

/**
 * A gated tool with NO transition field. The body's write to the slot is what
 * moves the position, which the result then reports.
 */
export const identify = callFlow.tool({
  description: "Latch the call onto one customer",
  inputSchema: z.object({ email: z.string() }),
  when: ["identifying", "serving"],
  execute: ({ email }, ctx) =>
    callSlot.update(ctx, (call) => {
      if (!email.includes("@")) return toolFailure("That is not an email address.");
      call.customerId = email;
      return { identified: email };
    }),
});

/** A `when` naming a nested position, and an async body. */
export const closeOut = callFlow.tool({
  description: "Record the closing note",
  inputSchema: z.object({ note: z.string() }),
  when: "serving",
  async execute({ note }, ctx) {
    await Promise.resolve();
    return callSlot.update(ctx, (call) => {
      call.notes.push(note);
      return { notes: call.notes.length };
    });
  },
});

/** The authoring type is nameable, for a helper that builds one. */
export function gatedRead(
  description: string,
): DerivedFlowToolDef<z.ZodObject<Record<string, never>>, { ok: true }> {
  return { description, when: "serving", execute: () => ({ ok: true }) };
}

/** A projection off a derived flow needs no actor. */
export const callProjection = callFlow.projection((at: FlowPosition) => ({
  step: at.state,
  next: at.instruction,
  done: at.done,
}));

/** The unknown-state error is catchable by name. */
export function locateSafely(call: Call): string | null {
  try {
    return callFlow.locate(call);
  } catch (err: unknown) {
    return err instanceof UnknownFlowStateError ? err.state : null;
  }
}

// ── The stored flow, with the invariant epoch 2 adds ─────────────────────────

interface Board {
  incidents: string[];
}

const boardSlot = sessionSlot("board", (): Board => ({ incidents: [] }));

const shiftMachine = setup({
  types: {} as { events: { type: "LOGGED" } | { type: "TRIAGED" } },
}).createMachine({
  id: "shift",
  initial: "standby",
  states: {
    standby: {
      meta: { instruction: "Nothing is logged. Take the call." },
      on: { LOGGED: "working" },
    },
    working: {
      initial: "triaging",
      states: {
        triaging: { meta: { instruction: "Set the severity." }, on: { TRIAGED: "dispatching" } },
        dispatching: { meta: { instruction: "Assign units." } },
      },
    },
  },
});

/**
 * A stored flow keeps `send`/`sendFrom` — this is the shape that cannot derive,
 * because `triaging` versus `dispatching` records what the dispatcher has done
 * rather than anything true of the board. The invariant holds the half that IS a
 * function of the data.
 */
export const shiftFlow = flow("shift", shiftMachine, {
  durable: true,
  invariant: (at: FlowPosition, ctx) => {
    const logged = boardSlot.get(ctx).incidents.length;
    if (at.state === "standby" && logged > 0) return `standby with ${logged} logged.`;
    if (at.state !== "standby" && logged === 0) return "working with nothing logged.";
  },
});

/** `check` is public, so a spec can assert agreement directly. */
export function agrees(ctx: Parameters<typeof shiftFlow.check>[0]): boolean {
  return shiftFlow.check(ctx) === undefined;
}

/** Epoch 1's fields still work on a stored flow: `send` and `sendFrom`. */
export const logCall = shiftFlow.tool({
  description: "Log a new call",
  inputSchema: z.object({ what: z.string() }),
  when: ["standby", "working"],
  send: { type: "LOGGED" },
  execute: ({ what }, ctx) =>
    boardSlot.update(ctx, (board) => {
      board.incidents.push(what);
      return { logged: board.incidents.length };
    }),
});

export const triage = shiftFlow.tool({
  description: "Set the severity",
  inputSchema: z.object({ severity: z.enum(["low", "high"]) }),
  when: "working",
  sendFrom: (result: { set: boolean }) => (result.set ? { type: "TRIAGED" as const } : undefined),
  execute: ({ severity }) => ({ set: severity === "high" }),
});
