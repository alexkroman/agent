/**
 * The dialog-stack tools: delegate, escalate, confirm, cancel.
 *
 * These four shapes are the customer-support tutorial's control plane, and the
 * DEFINITIONS live together here because they share this module's helpers —
 * `activeAssistant`, `applyPending`, `note`. Each is NAMED by a file under
 * `tools/`, which is what registers it: a tool's name is its file name, so
 * `tools/to_flight_assistant.ts` is one line handing {@link delegationTool} an
 * id, and `tools/confirm_action.ts` one line calling {@link confirmActionTool}.
 * Every file in `tools/` therefore default-exports the RESULT of a call: a
 * factory per tool rather than a shared const, so nothing here is a re-export
 * — which is what `noExportedImports` would otherwise have to be told to allow.
 *
 * The delegation four are still generated rather than written out. The notebook
 * declares `ToFlightBookingAssistant`, `ToHotelBookingAssistant`,
 * `ToBookCarRental` and `ToBookExcursion` as four pydantic classes differing
 * only in the docstring, and the whole content of one is an entry in
 * {@link SPECIALISTS} — so the factory stays and the files name its instances,
 * which is a different thing from four near-identical tool bodies. A domain tool
 * — one that searches or books something — is written in its own file, because
 * each of those really is different work.
 */

import type { ToolDef } from "@alexkroman1/aai";
import { z } from "zod";
import {
  activeAssistant,
  applyPending,
  describeAction,
  gateFlow,
  note,
  SPECIALISTS,
  type SpecialistId,
  tripSlot,
} from "./shared.ts";

/**
 * `to_<specialist>_assistant` — push a desk onto the dialog stack.
 *
 * The result IS the specialist's brief. A voice session's system prompt is
 * fixed at connect, so there is no swapping it the way their graph swaps the
 * runnable; handing the brief back as the tool result puts it in the last thing
 * the model reads before it speaks, which is the same effect by a route that
 * works on a live call. `request` exists for the same reason theirs does: the
 * specialist needs what the caller actually asked for, not just that they were
 * transferred.
 */
export function delegationTool(id: SpecialistId): ToolDef {
  const specialist = SPECIALISTS[id];
  return tripSlot.updateTool({
    description:
      `Hand the call to the ${specialist.title}. Use this as soon as the caller ` +
      "raises something that desk owns — do not answer it yourself. Do not " +
      "mention the transfer; the caller should hear one continuous conversation.",
    inputSchema: z.object({
      request: z
        .string()
        .max(500)
        .describe("What the caller asked for, in their own words where possible"),
    }),
    execute(args, trip) {
      // Re-entering a desk the call is already on would grow the stack without
      // bound over a long call; the brief is still worth re-reading.
      if (activeAssistant(trip) !== id) trip.dialogState.push(id);
      note(trip, `→ ${specialist.title}: ${args.request}`);
      return {
        desk: specialist.title,
        instructions: specialist.instructions,
        request: args.request,
      };
    },
  });
}

/**
 * `complete_or_escalate` — pop back to the concierge.
 *
 * Kept under its original name because the name is load-bearing: it covers BOTH
 * "this desk is finished" and "this desk cannot help", and a model offered only
 * a `done` tool will keep trying to answer things the desk has no tools for.
 * The `reason` is what the concierge is handed on the way back up.
 */
export function completeOrEscalateTool(): ToolDef {
  return tripSlot.updateTool({
    description:
      "Hand the call back to the main concierge. Use this when the current desk's " +
      "work is finished, when the caller changes the subject to something this " +
      "desk does not handle, or when they change their mind.",
    inputSchema: z.object({
      reason: z
        .string()
        .max(300)
        .describe("Why the call is going back — what is done, or what the caller now wants"),
    }),
    execute(args, trip) {
      const left = activeAssistant(trip);
      // `primary` stays at the bottom — the slot's `after` hook restores it if a
      // pop ever empties the stack.
      if (trip.dialogState.length > 1) trip.dialogState.pop();
      note(trip, `← back to concierge: ${args.reason}`);
      return {
        returnedFrom: left === "primary" ? "concierge" : SPECIALISTS[left].title,
        nowHandling: "concierge",
        reason: args.reason,
        instructions:
          "You are the main concierge again. Pick up what the caller asked for; " +
          "delegate again if it belongs to another desk.",
      };
    },
  });
}

/**
 * `confirm_action` — the caller said yes.
 *
 * This is the only tool in the template that changes a booking. Their graph
 * halts before a sensitive tool and resumes on approval; the halt here is that
 * every sensitive tool stages instead of acting, so the approval has somewhere
 * to arrive.
 *
 * **`when: "awaitingConfirmation"` is the other side of that halt.** It used to
 * be a null check inside {@link applyPending} — "Nothing is waiting for
 * confirmation. Use the booking tool first." — which is the question "where is
 * this conversation", asked of the payload. The gate asks the machine instead,
 * and its refusal carries the state's own instruction. `SETTLED` fires only when
 * the body did NOT answer with a {@link ToolFailure}, so an application that
 * failed leaves the change staged and the caller still being asked.
 */
export function confirmActionTool(): ToolDef {
  return gateFlow.tool({
    description:
      "Apply the change the caller has just confirmed out loud. Only call this " +
      "after you have read the change back and heard a clear yes.",
    when: "awaitingConfirmation",
    send: { type: "SETTLED" },
    execute: (_args, ctx) => tripSlot.update(ctx, (trip) => applyPending(trip)),
  });
}

/**
 * `cancel_action` — the caller said no. Drops the staged action, changes nothing.
 *
 * Gated for the same reason as `confirm_action`, and its own "nothing was
 * waiting" arm is gone with the same argument.
 */
export function cancelActionTool(): ToolDef {
  return gateFlow.tool({
    description:
      "Discard the change the caller just declined. Call this when they say no, " +
      "or when they want to change the details before confirming.",
    when: "awaitingConfirmation",
    send: { type: "SETTLED" },
    execute: (_args, ctx) =>
      tripSlot.update(ctx, (trip) => {
        const action = trip.pending;
        // Reachable only if the position and the payload disagree; see
        // `applyPending`. Reported rather than thrown, mid-call.
        if (!action) return { discarded: null, message: "Nothing was staged after all." };
        trip.pending = null;
        const described = describeAction(action);
        const summary = typeof described === "string" ? described : action.kind;
        note(trip, `Declined: ${summary}`);
        return { discarded: summary, message: "Nothing was changed." };
      }),
  });
}
