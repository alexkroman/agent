import type { ToolContext } from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai";
import { createToolContext, expectDialogOk, expectToolOk } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import type { StagedResult } from "./pending.ts";
import { retailSlot } from "./store.ts";
import cancelChange from "./tools/cancel_change.ts";
import cancelPendingOrder from "./tools/cancel_pending_order.ts";
import confirmChange from "./tools/confirm_change.ts";
import findUserIdByEmail from "./tools/find_user_id_by_email.ts";
import getOrderDetails from "./tools/get_order_details.ts";
import modifyUserAddress from "./tools/modify_user_address.ts";
import returnDeliveredOrderItems from "./tools/return_delivered_order_items.ts";
import transferToHumanAgents from "./tools/transfer_to_human_agents.ts";

/** Aarav Anderson: one pending order (#W9300146, $153.23 on a gift card) and
 *  one delivered order (#W4316152), which is every shape these cases need. */
async function aaravCtx(): Promise<ToolContext> {
  const ctx = createToolContext();
  expectToolOk(await findUserIdByEmail.execute({ email: "aarav.anderson9752@example.com" }, ctx));
  return ctx;
}

const stageCancel = (ctx: ToolContext) =>
  cancelPendingOrder.execute({ order_id: "#W9300146", reason: "no longer needed" }, ctx);

describe("staging", () => {
  test("a staging tool changes NOTHING and moves the call to awaitingConfirmation", async () => {
    const ctx = await aaravCtx();
    const before = structuredClone(retailSlot.get(ctx).store.orders["#W9300146"]);

    const staged = expectDialogOk<StagedResult>(await stageCancel(ctx));

    expect(staged.state).toBe("serving.awaitingConfirmation");
    expect(staged.result.staged).toBe("cancel_pending_order");
    // The whole claim of this template's policy section, as one assertion: the
    // tool that used to cancel and refund on its first call now does neither.
    expect(retailSlot.get(ctx).store.orders["#W9300146"]).toEqual(before);
    const card =
      retailSlot.get(ctx).store.users.aarav_anderson_8794?.payment_methods.gift_card_7245904;
    expect(card?.source === "gift_card" && card.balance).toBe(17);
  });

  test("the readback names the order, the items, the amount and where the money goes", async () => {
    const ctx = await aaravCtx();
    const staged = expectToolOk<StagedResult>(await stageCancel(ctx));
    expect(staged.read_back).toContain("#W9300146");
    expect(staged.read_back).toContain("153.23");
    expect(staged.read_back).toContain("gift_card_7245904");
    expect(staged.read_back).toContain("no longer needed");
  });

  test("the result says out loud that nothing has happened", async () => {
    const ctx = await aaravCtx();
    const staged = expectToolOk<StagedResult>(await stageCancel(ctx));
    expect(staged.message).toContain("NOTHING HAS CHANGED YET");
    expect(staged.message).toContain("confirm_change");
  });

  test("a second stage is refused, and the refusal names the one already waiting", async () => {
    const ctx = await aaravCtx();
    expectToolOk(await stageCancel(ctx));

    // A DIFFERENT change, so this is not a repeat of the first call.
    const second = await modifyUserAddress.execute(
      {
        user_id: "aarav_anderson_8794",
        address1: "1 A St",
        address2: "",
        city: "Springfield",
        state: "OR",
        country: "USA",
        zip: "97477",
      },
      ctx,
    );
    expect(isToolFailure(second)).toBe(true);
    // Naming the waiting sentence is why the staging tools are gated on
    // `serving` rather than on `serving.helping`: a state's instruction is
    // static and could only have said which STATE the call is in.
    expect(isToolFailure(second) && second.error).toContain("#W9300146");
    expect(isToolFailure(second) && second.error).toContain("cancel_change");
    expect(retailSlot.get(ctx).store.users.aarav_anderson_8794?.address.city).not.toBe(
      "Springfield",
    );
  });
});

describe("confirming", () => {
  test("confirm_change applies the staged change and returns to helping", async () => {
    const ctx = await aaravCtx();
    expectToolOk(await stageCancel(ctx));

    const done = expectDialogOk<{ confirmed: string; status: string }>(
      await confirmChange.execute({}, ctx),
    );
    expect(done.state).toBe("serving.helping");
    expect(done.result.confirmed).toBe("cancel_pending_order");
    expect(retailSlot.get(ctx).store.orders["#W9300146"]?.status).toBe("cancelled");
    expect(retailSlot.get(ctx).pending).toBeNull();
  });

  test("confirm_change with nothing staged is refused by the GATE, before its body", async () => {
    const ctx = await aaravCtx();
    const result = await confirmChange.execute({}, ctx);
    expect(isToolFailure(result)).toBe(true);
    // The SDK writes this refusal from `when` plus the state's instruction, so
    // it says where the call is rather than merely that this was not allowed —
    // and the body, which is the only thing in the template that mutates, never
    // ran to find out.
    expect(isToolFailure(result) && result.error).toContain("serving.helping");
    expect(isToolFailure(result) && result.error).toContain("STAGES");
  });

  test("confirming twice is refused — the second call has nothing staged", async () => {
    const ctx = await aaravCtx();
    expectToolOk(await stageCancel(ctx));
    expectToolOk(await confirmChange.execute({}, ctx));

    const again = await confirmChange.execute({}, ctx);
    expect(isToolFailure(again)).toBe(true);
    // One cancellation, one refund: a double-apply would have credited the card
    // twice, which is the failure a "did we already do this?" flag gets wrong.
    const card =
      retailSlot.get(ctx).store.users.aarav_anderson_8794?.payment_methods.gift_card_7245904;
    expect(card?.source === "gift_card" && card.balance).toBe(170.23);
  });
});

describe("cancelling a staged change", () => {
  test("cancel_change drops it, changes nothing, and frees the call", async () => {
    const ctx = await aaravCtx();
    expectToolOk(await stageCancel(ctx));

    const dropped = expectDialogOk<{ dropped: string | null; message: string }>(
      await cancelChange.execute({}, ctx),
    );
    expect(dropped.state).toBe("serving.helping");
    expect(dropped.result.dropped).toBe("cancel_pending_order");
    expect(dropped.result.message).toContain("#W9300146");
    expect(retailSlot.get(ctx).store.orders["#W9300146"]?.status).toBe("pending");
    expect(retailSlot.get(ctx).pending).toBeNull();
  });

  test("a corrected change can be staged straight after", async () => {
    const ctx = await aaravCtx();
    expectToolOk(await stageCancel(ctx));
    expectToolOk(await cancelChange.execute({}, ctx));

    // The caller changed their mind about which order — the very thing
    // `cancel_change` exists for.
    const restaged = expectToolOk<StagedResult>(
      await returnDeliveredOrderItems.execute(
        {
          order_id: "#W4316152",
          item_ids: ["7292993796"],
          payment_method_id: "gift_card_7245904",
        },
        ctx,
      ),
    );
    expect(restaged.staged).toBe("return_delivered_order_items");
  });
});

describe("what stays legal while a change waits", () => {
  test("a read is still answerable — 'what was the total again?'", async () => {
    const ctx = await aaravCtx();
    expectToolOk(await stageCancel(ctx));
    // `when: "serving"` matches both children, which is what makes this work.
    const read = expectDialogOk<{ order_id: string }>(
      await getOrderDetails.execute({ order_id: "#W9300146" }, ctx),
    );
    expect(read.result.order_id).toBe("#W9300146");
    // A read does not settle anything, so the change is still waiting.
    expect(read.state).toBe("serving.awaitingConfirmation");
  });

  test("a caller can still ask for a human, and everything refuses afterwards", async () => {
    const ctx = await aaravCtx();
    expectToolOk(await stageCancel(ctx));

    const transferred = expectDialogOk(
      await transferToHumanAgents.execute({ summary: "wants a human" }, ctx),
    );
    // `TRANSFERRED` is declared on the `serving` PARENT, which is what lets it
    // fire from inside the confirmation.
    expect(transferred.state).toBe("transferred");
    expect(transferred.done).toBe(true);

    // Including the two settling tools: a call given away cannot be finished.
    expect(isToolFailure(await confirmChange.execute({}, ctx))).toBe(true);
    expect(isToolFailure(await cancelChange.execute({}, ctx))).toBe(true);
    expect(retailSlot.get(ctx).store.orders["#W9300146"]?.status).toBe("pending");
  });
});
