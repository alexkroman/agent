// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:state` epoch 14.
 *
 * The `shared.ts` of a clinic front desk — where a stateful agent keeps its
 * session state, which is a {@link sessionSlot} and nothing else: one DURABLE
 * slot holding the shift the receptionist is working, one VIRTUAL slot holding
 * a value a database could not store, the two tool builders that read and write
 * the first, and the projection both ends render it through. Written the way it
 * was authored at epoch 14, and it must keep compiling for as long as that
 * epoch is advertised as supported.
 *
 * ## What moved, and why epoch 14 survives it
 *
 * Nothing this capability exports. `aai:state`'s list is byte-identical across
 * the bump — `sessionSlot`, `SessionSlot`, `SessionSlotOptions`, `SlotHolder`,
 * `SlotStore`, `SlotToolDef`, `StateProjection`, `DeepReadonly` — and the
 * report hash moved because `WorkflowBody`'s second parameter type was renamed
 * `WorkflowCtx` -> `WorkflowContext`.
 *
 * The route in is {@link SlotToolDef}, whose `execute` takes a `ToolContext` as
 * its third parameter — so `ctx.workflows`, and everything a `WorkflowClient`
 * mentions, is in this capability's rollup. That is not incidental to how slots
 * are authored, which is why {@link checkInLabs} below uses it: a slot-backed
 * tool that hands slow work to a durable run and records the run id in the slot
 * is the ordinary shape. What it does not do is NAME a workflow type. It starts
 * a run by NAME (`ctx.workflows.start("labIntake", …)`, the string overload), so
 * neither `WorkflowDef` nor its body's context appears anywhere in this file,
 * and a rename of either cannot reach it.
 *
 * **The directions that WOULD break this file** are the ones a slot's own
 * contract turns on, and none of them is a rename. `update` losing its
 * synchronous draft window; `get` widening from {@link DeepReadonly} back to a
 * shallow `Readonly`, which would make {@link frozenBoard}'s helpers compile
 * against a value the runtime still freezes; `projection` becoming a plain
 * record rather than the CALLABLE that renders a session which has run no tool;
 * `SlotHolder` requiring a full `ToolContext` again, which is what
 * {@link holderFor} depends on not doing.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 14 has to be dropped with a reason.
 */

import { z } from "zod";
import {
  type DeepReadonly,
  pushCapped,
  type SessionSlot,
  type SessionSlotOptions,
  type SlotHolder,
  type SlotStore,
  type SlotToolDef,
  type StateProjection,
  sessionSlot,
  type ToolDef,
  type ToolInputSchema,
  toolFailure,
} from "../../../index.ts";

/** ── EDIT: what one shift holds. ───────────────────────────────────────── */
export interface Visit {
  id: number;
  patient: string;
  reason: string;
  arrivedAt: number;
  /** Set once the labs have been handed off to a run of their own. */
  labRunId?: string;
}

export interface Shift {
  visits: Visit[];
  nextId: number;
  /** Newest last, and pruned by {@link shiftOptions}'s `after`. */
  log: string[];
}

/** How many log lines a shift keeps. A slot's value crosses the wire on every
 *  projection and feeds the model through tool results, so it needs a cap. */
const MAX_LOG = 40;

export function emptyShift(): Shift {
  return { visits: [], nextId: 1, log: [] };
}

/**
 * ── EDIT: the invariants that hold after every write. ────────────────────
 *
 * `after` runs on the draft at the end of every successful `update`, which is
 * what keeps the pruning rule with the slot rather than re-listed at each of the
 * mutating call sites — where one of them eventually forgets it. It is
 * SYNCHRONOUS for the same reason the mutation window is, and an `async` hook is
 * a compile error naming the rule rather than a value stored before it ran.
 *
 * Written out as a typed constant rather than inline so the options bag is
 * reviewable on its own, which is the shape a growing agent ends up with.
 */
const shiftOptions: SessionSlotOptions<Shift> = {
  after: (draft) => {
    draft.log = draft.log.slice(-MAX_LOG);
  },
  // The default, stated: the shift must survive a redeploy mid-call, and every
  // field above is something a database can hold.
  durable: true,
};

/** The shift, as one typed slot. Its key is its identity — nothing else may
 *  take `"shift"`, a dialog included. */
export const shiftSlot: SessionSlot<"shift", Shift> = sessionSlot(
  "shift",
  emptyShift,
  shiftOptions,
);

/**
 * ── EDIT: the value that CANNOT be stored. ───────────────────────────────
 *
 * A `Map` survives neither the storability check nor a round trip through the
 * database — it arrives as `{}` — so the directory cache declares itself
 * VIRTUAL. That is a property of the DECLARATION, decided once here, rather
 * than a per-write opt-out somebody has to remember at each call site; a virtual
 * slot is neither checked, frozen nor committed, and it does not survive the
 * process, which is the right lifetime for a cache.
 */
export const directorySlot = sessionSlot("directory", () => new Map<string, string>(), {
  durable: false,
});

/**
 * A shift as a READ hands it out: deep-frozen, and typed to say so.
 *
 * The pure helpers below take this rather than {@link Shift}, which is the
 * widening a deep-readonly read forces and the reason it is worth doing — a
 * mutable draft still satisfies it, so a helper called from inside an
 * `updateTool` is unaffected, while a helper that WOULD have mutated stops
 * compiling instead of throwing on its first live call.
 */
export type FrozenShift = DeepReadonly<Shift>;

/** Who is still in the waiting room. */
export function waiting(shift: FrozenShift): readonly DeepReadonly<Visit>[] {
  return shift.visits.filter((visit) => visit.labRunId === undefined);
}

/**
 * The board, as it is handed to a helper that is not in a tool.
 *
 * Every slot method takes a {@link SlotHolder} — `{ slots, sessionId }`, the two
 * fields any of them ever read — rather than a whole `ToolContext`. That is what
 * lets this be called from an `agent({ events })` handler and from a spec, both
 * of which have a {@link SlotStore} and no tool call.
 */
export function frozenBoard(holder: SlotHolder): FrozenShift {
  return shiftSlot.get(holder);
}

/** A holder built from the two things a slot actually needs — what a session
 *  event handler already has, and what a spec assembles. */
export function holderFor(slots: SlotStore, sessionId: string): SlotHolder {
  return { slots, sessionId };
}

/**
 * ── EDIT: the per-agent wrapper every read tool goes through. ────────────
 *
 * `SlotToolDef` is the authoring shape — `description`, an optional
 * `inputSchema`, and an `execute` handed the slot's value SECOND, because that
 * is what a slot-backed body actually uses. Naming it here is what lets one
 * wrapper add the desk's own prefix to every tool description instead of each
 * module restating it.
 *
 * The result is a plain {@link ToolDef} carrying the body's own return type, so
 * a custom client can infer what a tool answers rather than reading `unknown`.
 */
export function deskRead<P extends ToolInputSchema, R>(
  def: SlotToolDef<P, FrozenShift, R>,
): ToolDef<P, R> {
  return shiftSlot.tool({ ...def, description: `${def.description} (front desk)` });
}

/**
 * A write, as `tools/check_in.ts` default-exports it.
 *
 * `updateTool` hands the body a mutable DRAFT and stores whatever it leaves
 * behind when it returns, so a read-modify-write is atomic with no lock of its
 * own — which matters because the model's tool calls within one step run
 * concurrently. The body is SYNCHRONOUS, and that is enforced: an `async` one is
 * a compile error naming the rule, because an `await` inside the window writes
 * to a value that has already been stored.
 */
export const checkIn = shiftSlot.updateTool({
  description: "Check a patient in and put them in the waiting room.",
  inputSchema: z.object({
    patient: z.string().max(80),
    reason: z.string().max(200).describe("What they are here for, in their own words"),
  }),
  execute: (args, shift) => {
    const visit: Visit = {
      id: shift.nextId,
      patient: args.patient,
      reason: args.reason,
      // Fine in a tool body — a slot mutation is not a replayed workflow step,
      // so nothing here has to be deterministic.
      arrivedAt: Date.now(),
    };
    shift.visits.push(visit);
    shift.nextId += 1;
    pushCapped(shift.log, `checked in ${visit.patient} (#${visit.id})`, MAX_LOG);
    return { visitId: visit.id, waiting: waiting(shift).length };
  },
});

/**
 * A read that hands the slow half to a durable run.
 *
 * This is the member the "what moved" note above is about: `execute`'s third
 * parameter is the tool context, so `ctx.workflows` is reachable from this
 * capability's report. The run is started by NAME rather than by def, which is
 * the right call from a `shared.ts` — the def lives in `agent.ts`, and importing
 * it here would be a cycle for the sake of a string.
 *
 * `slot.update` after the await rather than inside it: the run id has to be
 * stored, and the mutation window is the wrong place to be waiting on a network
 * call.
 */
export const checkInLabs = deskRead({
  description: "Send a patient's lab work off for processing.",
  inputSchema: z.object({ visitId: z.number().int() }),
  execute: async (args, shift, ctx) => {
    const visit = shift.visits.find((candidate) => candidate.id === args.visitId);
    if (!visit) return toolFailure(`No visit #${args.visitId} on this shift.`);
    if (visit.labRunId !== undefined) return toolFailure("Those labs are already running.");
    const runId = await ctx.workflows.start(
      "labIntake",
      { patient: visit.patient, reason: visit.reason },
      { key: ctx.sessionId },
    );
    shiftSlot.update(ctx, (draft) => {
      const target = draft.visits.find((candidate) => candidate.id === args.visitId);
      if (target) target.labRunId = runId;
      pushCapped(draft.log, `labs away for #${args.visitId}`, MAX_LOG);
    });
    return { visitId: args.visitId, runId };
  },
});

/** ── EDIT: what the browser sees. ──────────────────────────────────────── */
export interface ShiftView {
  waiting: number;
  patients: readonly string[];
  lastLine: string | undefined;
}

/**
 * The projection BOTH ends use — `agent({ syncState })` on the server, the
 * matching hook in `client.tsx`.
 *
 * A projection rather than the raw shift: the client needs a count and a list,
 * not the log or the run ids, and this is where that decision is made. It is
 * CALLABLE and carries the slot's key and default, which is what lets the
 * runtime render a session that has not run a tool yet — so nothing downstream
 * has to optional-chain a shift that exists by construction.
 */
export const shiftProjection: StateProjection<ShiftView> = shiftSlot.projection((shift) => ({
  waiting: waiting(shift).length,
  patients: waiting(shift).map((visit) => visit.patient),
  lastLine: shift.log.at(-1),
}));

/**
 * End the shift.
 *
 * `reset` rather than `set(holder, emptyShift())`: it is the same store write
 * and it cannot get the default wrong, which is the failure the pair exists to
 * make impossible — a hand-built "empty" value drifts from `create` the moment a
 * field is added.
 */
export function endShift(holder: SlotHolder): FrozenShift {
  return shiftSlot.reset(holder);
}

/**
 * Restore a shift from somewhere else — a handover, an import, a spec's fixture.
 *
 * `set` stores a COPY, so the freeze lands on the slot's own object and never on
 * the caller's: the value passed in here is still the caller's to mutate
 * afterwards, which is exactly the case a restore is in.
 */
export function restoreShift(holder: SlotHolder, shift: Shift): FrozenShift {
  return shiftSlot.set(holder, shift);
}
