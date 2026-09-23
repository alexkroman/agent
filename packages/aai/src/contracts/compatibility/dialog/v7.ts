// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:dialog` epoch 7.
 *
 * **Epoch 8 renamed nothing an author writes.** `DialogEvent<S>` used to be
 * written over three private helper types (`EventOf`, `NamesIn`, `NamesInMap`)
 * that no subpath exported, so its hash carried their bodies and a consumer had
 * to satisfy shapes it could not name. They are folded into one exported
 * `DialogEventNames<M>` now, and `DialogEvent<S>` is rewritten over it. The
 * probe cannot prove two DIFFERENT declarations of a generic conditional equal,
 * so it reported the change as incompatible; the union it produces for any
 * spec is the same, which this file shows by sending exactly the events an
 * epoch-7 dialog declared, and by NOT being able to send the `@` ones.
 *
 * `v4.ts` and `v5.ts` already name all fifteen of epoch 7's exports, so this
 * carries only the shape the rewritten union lands in.
 *
 * **Its specifiers are RELATIVE**, for the reason every frozen example's are.
 *
 * @module
 */

import type { DialogEvent, DialogGate, SlotHolder } from "../../../index.ts";
import { dialog } from "../../../index.ts";

const spec = {
  initial: "intake",
  states: {
    intake: {
      instruction: "Take the order.",
      on: { ORDERED: "payment", "@session.timed-out": "abandoned" },
    },
    payment: {
      initial: "card",
      states: {
        card: { instruction: "Take the card.", on: { DECLINED: "retry" } },
        retry: { instruction: "Ask for another card.", on: { PAID: "done" } },
      },
    },
    done: { final: true },
    abandoned: { final: true },
  },
} as const;

/** Every author-sendable event, at every depth — and no `@` name. */
export type OrderEvent = DialogEvent<typeof spec>;

const order = dialog("order", spec);

export function advance(ctx: SlotHolder): void {
  order.send(ctx, { type: "ORDERED" });
  order.send(ctx, { type: "DECLINED" });
  order.send(ctx, { type: "PAID" });
}

/** What `send` accepts. A session event arrives through `receive`, never `send`. */
type Sendable = Parameters<typeof order.send>[1]["type"];

/** Compiles only while `send` refuses the `@` event and still takes `PAID`. */
export const sessionEventsAreNotSendable: [
  "@session.timed-out" extends Sendable ? false : true,
  "PAID" extends Sendable ? true : false,
] = [true, true];

/** The gate a dialog tool carries, named on its own: `when` plus what it sends. */
export const paidGate: DialogGate<{ ok: boolean }, OrderEvent> = {
  when: "payment.card",
  sendFrom: (result) => (result.ok ? { type: "PAID" } : { type: "DECLINED" }),
};
