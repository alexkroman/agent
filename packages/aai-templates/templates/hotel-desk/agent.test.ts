/** The def a DEPLOYED agent runs: authored, plus what `tools/` and the prompt add. */
import agentDef from "virtual:aai/agent";
import type { ToolContext } from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
import {
  createToolContext,
  expectDialogOk,
  expectDialogRefused,
  toolInputIssues,
  toolRunner,
} from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import { luhnOk, validateCard } from "./card.ts";
import { deskFlow } from "./desk.ts";
import { DISPUTE_POLICIES, resolveDisputeOutcome } from "./disputes.ts";
import { listRoomOptions } from "./hotel.ts";
import { POLICIES } from "./policies.ts";
import {
  addDays,
  computeInvoice,
  daysBetween,
  isIsoDate,
  mintCode,
  PRICING,
  speakCode,
  speakUsd,
  spokenDate,
  spokenTime,
  TODAY,
} from "./records.ts";
import { deskProjection, deskView, hotelSlot } from "./shared.ts";

// ─── Harness ─────────────────────────────────────────────────────────────────

/** A tool by the name the model calls it by, bound to this agent. */
const run = toolRunner(agentDef);

/**
 * A PLAIN tool's own value, or a throw quoting the refusal.
 *
 * `expectToolOk` (`@alexkroman1/aai/testing`) unwraps a DIALOG tool's envelope;
 * thirty-two of this template's tools are ungated `hotelSlot` tools whose result
 * is their own value, so this is the same "fail at the call, quoting what was
 * refused" for them.
 */
function ok<T>(result: unknown): T {
  if (isToolFailure(result)) throw new Error(`tool refused: ${result.error}`);
  return result as T;
}

/** What the runtime offers the desk dialog when the caller says something. */
const HEARD_SOMETHING: SessionEvent = {
  type: "user-transcript.committed",
  text: "yes, that's right",
  meta: { id: "evt_1", at: 0 },
};

/** And when they hang up. */
const CALLER_GONE: SessionEvent = { type: "session.timed-out", meta: { id: "evt_2", at: 0 } };

/** Where the call is, without going through a tool. */
const at = (ctx: ToolContext) => deskFlow.position(ctx).state;

/** The caller answers — their next committed turn is what discharges an owed read-back. */
const callerAnswers = (ctx: ToolContext) => deskFlow.receive(ctx, HEARD_SOMETHING).state;

/** A context whose history holds `n` caller turns — what the idempotency guards read. */
const withCallerTurns = (n: number) =>
  createToolContext({
    messages: Array.from({ length: n }, (_, i) => ({
      role: "user" as const,
      content: `turn ${i}`,
    })),
  });

/** Verify as a seeded guest, the way the model has to. */
async function verify(ctx: ToolContext, lastName: string, confirmationCode: string) {
  return ok<{ code: string }>(await run("verify_booking", { lastName, confirmationCode }, ctx));
}

const A_CARD = {
  cardNumber: "4532 0000 0001 4471",
  expiryMonth: 12,
  expiryYear: 29,
  securityCode: "321",
  cardholderName: "Maria Whitfield",
};

/** Walk a fresh call through a whole new booking up to the read-back. */
async function bookUpToReadBack(ctx: ToolContext) {
  expectDialogOk(await run("start_room_booking", ctx));
  expectDialogOk(
    await run("set_stay", { checkIn: "2026-07-14", checkOut: "2026-07-17", guests: 2 }, ctx),
  );
  expectDialogOk(await run("choose_room", { roomType: "queen_2beds", view: "garden" }, ctx));
  expectDialogOk(
    await run(
      "set_extras",
      { breakfast: false, valet: false, lateCheckout: false, pets: false },
      ctx,
    ),
  );
  expectDialogOk(
    await run(
      "record_guest_details",
      {
        firstName: "Maria",
        lastName: "Whitfield",
        email: "Maria.Whitfield@gmail.com",
        phone: "123-555-0170",
      },
      ctx,
    ),
  );
  expectDialogOk(await run("record_card", A_CARD, ctx));
}

// ─── 1. Records: money, dates, codes ─────────────────────────────────────────

describe("records.ts", () => {
  test("a stay is priced once, with tax, and the line items add up to the total", () => {
    const priced = computeInvoice(24_000, 2, ["breakfast"]);
    expect(priced).toMatchObject({ subtotal: 53_000, taxes: 6360, total: 59_360 });
    expect(priced.lineItems.reduce((sum, li) => sum + li.amount, 0)).toBe(priced.total);
    expect(priced.lineItems.map((li) => li.label)).toEqual([
      "Room (2 nights)",
      "Breakfast (2 nights)",
      `Tax (${PRICING.taxRatePct}%)`,
    ]);
  });

  test("money and codes are spoken the way a phone needs them", () => {
    expect(speakUsd(24_000)).toBe("240 dollars");
    expect(speakUsd(24_050)).toBe("240 dollars and 50 cents");
    // The dash is the WORD "dash", not four more letters.
    expect(speakCode("HTL-AB12")).toBe("H, T, L, dash, A, B, 1, 2");
  });

  test("dates: TODAY is the simulation pin, and the helpers agree with the calendar", () => {
    expect(TODAY).toBe("2026-06-08");
    expect(spokenDate(TODAY)).toBe("Monday, June 8");
    expect(addDays(TODAY, 25)).toBe("2026-07-03");
    expect(daysBetween("2026-07-14", "2026-07-17")).toBe(3);
    expect(spokenTime("19:30")).toBe("7:30 PM");
    expect(spokenTime("21:00")).toBe("9 PM");
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-06-08")).toBe(true);
  });

  test("a minted code carries no character a caller could mishear as another", () => {
    for (let i = 0; i < 50; i++)
      expect(mintCode("HTL")).toMatch(/^HTL-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/);
    expect(mintCode("X", new Set())).not.toBe(mintCode("X", new Set()));
  });

  test("the card check is Luhn, and every refusal names one field", () => {
    expect(luhnOk("4532000000014471")).toBe(true);
    expect(luhnOk("4532000000014472")).toBe(false);
    const ok = validateCard(A_CARD);
    expect(ok).toMatchObject({ last4: "4471", issuer: "Visa", expiry: "12/29" });
    expect(validateCard({ ...A_CARD, cardNumber: "4532 0000 0001 4472" })).toMatchObject({
      error: expect.stringContaining("one digit is likely off"),
    });
    expect(validateCard({ ...A_CARD, expiryYear: 2025 })).toMatchObject({
      error: expect.stringContaining("expired"),
    });
    expect(validateCard({ ...A_CARD, securityCode: "12" })).toMatchObject({
      error: expect.stringContaining("3 or 4 digits"),
    });
  });
});

// ─── 2. The seed's scenarios are the spec's ──────────────────────────────────

describe("the seeded hotel", () => {
  test("tonight, the only free room is the garden queen the seed keeps for Robert Klein", () => {
    const ctx = createToolContext();
    const tonight = listRoomOptions(hotelSlot.get(ctx), {
      checkIn: TODAY,
      checkOut: addDays(TODAY, 1),
      guests: 2,
    });
    expect(tonight).toEqual([{ type: "queen_2beds", view: "garden", nightlyRate: 22_000 }]);
  });

  test("Friday July 3 is sold out, and the desk says so rather than inventing a room", async () => {
    const empty = ok<{ available: boolean; message: string }>(
      await run("check_room_availability", {
        checkIn: "2026-07-03",
        checkOut: "2026-07-04",
        guests: 2,
      }),
    );
    expect(empty.available).toBe(false);
    expect(empty.message).toMatch(/add_to_waitlist/);
    const open = ok<{ available: boolean; options: string }>(
      await run("check_room_availability", {
        checkIn: "2026-07-14",
        checkOut: "2026-07-17",
        guests: 2,
      }),
    );
    expect(open.available).toBe(true);
    expect(open.options).toContain("queen 2beds, garden view: 220 dollars/night");
  });

  test("the projection counts the house from the same records the tools read", () => {
    const view = deskView(hotelSlot.get(createToolContext()));
    expect(view).toMatchObject({
      verified: null,
      draft: null,
      ledger: [],
      inHouse: 13,
      arrivingToday: 5,
    });
    // The pre-first-tool-call frame the client renders is the same function.
    expect(deskProjection()).toEqual(view);
  });
});

// ─── 3. Verification is the tools' job ───────────────────────────────────────

describe("verification", () => {
  test("every booking tool refuses until verify_booking has run, naming it", async () => {
    const ctx = createToolContext();
    for (const name of [
      "lookup_booking",
      "lookup_invoice",
      "cancel_room_booking",
      "resolve_room_conflict",
    ]) {
      const refused = await run(name, ctx);
      expect(isToolFailure(refused) && refused.error).toMatch(/verify_booking/);
    }
    expect(isToolFailure(await run("flag_late_arrival", { note: "around 1 AM" }, ctx))).toBe(true);
  });

  test("last name plus code, or last name plus the card's last four — and nothing else", async () => {
    const byCode = createToolContext();
    expect((await verify(byCode, "Smith", "h t l dash a b 1 2")).code).toBe("HTL-AB12");
    expect(hotelSlot.get(byCode).verifiedCode).toBe("HTL-AB12");

    const byCard = createToolContext();
    ok(await run("verify_booking", { lastName: "smith", cardLast4: "4242" }, byCard));
    expect(hotelSlot.get(byCard).verifiedCode).toBe("HTL-AB12");

    const nothing = await run("verify_booking", { lastName: "Smith" });
    expect(isToolFailure(nothing) && nothing.error).toMatch(/PLUS/);
  });

  test("three strikes, and the refusal routes to a verification_help followup", async () => {
    const ctx = createToolContext();
    const first = await run(
      "verify_booking",
      { lastName: "Smith", confirmationCode: "HTL-0000" },
      ctx,
    );
    expect(isToolFailure(first) && first.error).toMatch(/Attempt 1 of 3/);
    await run("verify_booking", { lastName: "Smith", confirmationCode: "HTL-0000" }, ctx);
    const third = await run(
      "verify_booking",
      { lastName: "Smith", confirmationCode: "HTL-0000" },
      ctx,
    );
    expect(isToolFailure(third) && third.error).toMatch(/verification_help/);
    expect(hotelSlot.get(ctx).verifiedCode).toBeNull();
  });

  test("a cancelled booking does not verify, and the refusal names the one flow that takes it", async () => {
    const refused = await run("verify_booking", {
      lastName: "Wagner",
      confirmationCode: "HTL-FW77",
    });
    expect(isToolFailure(refused) && refused.error).toMatch(/reinstate_booking/);
  });
});

// ─── 4. The booking flow ─────────────────────────────────────────────────────

describe("the booking dialog", () => {
  test("a fresh call is at the desk, and every booking tool refuses there", async () => {
    const ctx = createToolContext();
    expect(at(ctx)).toBe("desk");
    for (const call of [
      run("set_stay", { checkIn: "2026-07-14", checkOut: "2026-07-17", guests: 2 }, ctx),
      run("choose_room", { roomType: "king" }, ctx),
      run("confirm_booking", ctx),
    ]) {
      const refused = expectDialogRefused(await call, "desk");
      expect(refused.error).toMatch(/start_room_booking/);
    }
    expect(hotelSlot.get(ctx).draft).toBeNull();
  });

  test("each recording tool lands the flow on the step the draft says is next", async () => {
    const ctx = createToolContext();
    expectDialogOk(await run("start_room_booking", ctx));
    expect(at(ctx)).toBe("booking.stay");
    // The options have not been offered, so a room cannot be picked yet.
    expectDialogRefused(await run("choose_room", { roomType: "queen_2beds" }, ctx), "booking.stay");

    const stay = expectDialogOk<{ options: string; next: string }>(
      await run("set_stay", { checkIn: "2026-07-14", checkOut: "2026-07-17", guests: 2 }, ctx),
    );
    expect(stay.state).toBe("booking.room");
    expect(stay.result.options).toContain("garden view");

    const room = expectDialogOk<{ extrasToOffer: string }>(
      await run("choose_room", { roomType: "queen_2beds", view: "garden" }, ctx),
    );
    expect(room.state).toBe("booking.extras");
    expect(room.result.extrasToOffer).toContain("breakfast: adds 75 dollars");
    // No total exists before the extras are answered.
    expect(hotelSlot.get(ctx).draft?.quotedTotal).toBeNull();
    expectDialogRefused(await run("confirm_booking", ctx), "booking.extras");

    const extras = expectDialogOk<{ total: string }>(
      await run(
        "set_extras",
        { breakfast: false, valet: false, lateCheckout: false, pets: false },
        ctx,
      ),
    );
    expect(extras.state).toBe("booking.details");
    expect(extras.result.total).toBe("739 dollars and 20 cents including tax");

    // A partial detail is stored the moment it is given, and the flow stays put.
    const named = expectDialogOk(
      await run("record_guest_details", { firstName: "Maria", lastName: "Whitfield" }, ctx),
    );
    expect(named.state).toBe("booking.details");
    const contact = expectDialogOk(
      await run(
        "record_guest_details",
        { email: "Maria.Whitfield@gmail.com", phone: "123-555-0170" },
        ctx,
      ),
    );
    expect(contact.state).toBe("booking.card");
    expect(hotelSlot.get(ctx).draft).toMatchObject({
      email: "maria.whitfield@gmail.com",
      phone: "1235550170",
    });

    const card = expectDialogOk(await run("record_card", A_CARD, ctx));
    expect(card.state).toBe("booking.readBack");
    // Only the last four ever reached the slot.
    expect(JSON.stringify(hotelSlot.get(ctx))).not.toContain("4532");
  });

  test("the read-back is OWED: confirm refuses until the caller has answered it", async () => {
    const ctx = createToolContext();
    await bookUpToReadBack(ctx);
    expect(at(ctx)).toBe("booking.readBack");
    const early = expectDialogRefused(await run("confirm_booking", ctx), "booking.readBack");
    expect(early.error).toMatch(/WAIT|answered/);
    expect(hotelSlot.get(ctx).bookings.some((b) => b.lastName === "Whitfield")).toBe(false);

    expect(callerAnswers(ctx)).toBe("booking.agreeing");
    const done = expectDialogOk<{ outcome: string; room: string; total: string; code: string }>(
      await run("confirm_booking", ctx),
    );
    expect(done.state).toBe("desk");
    expect(done.result).toMatchObject({
      outcome: "booked",
      room: "205",
      total: "739 dollars and 20 cents",
    });

    const hotel = hotelSlot.get(ctx);
    const booking = hotel.bookings.find((b) => b.code === done.result.code);
    expect(booking).toMatchObject({
      roomId: "205",
      total: 73_920,
      cardLast4: "4471",
      status: "confirmed",
    });
    expect(hotel.invoices.find((i) => i.bookingCode === done.result.code)?.total).toBe(73_920);
    expect(hotel.draft).toBeNull();
  });

  test("a correction after the read-back re-arms it", async () => {
    const ctx = createToolContext();
    await bookUpToReadBack(ctx);
    callerAnswers(ctx);
    // One more night: the garden queen is still free, so the pick survives and
    // the flow goes back to the read-back rather than to the offer.
    const redated = expectDialogOk(
      await run("set_stay", { checkIn: "2026-07-14", checkOut: "2026-07-18", guests: 2 }, ctx),
    );
    expect(redated.state).toBe("booking.readBack");
    expect(hotelSlot.get(ctx).draft?.roomType).toBe("queen_2beds");
    expectDialogRefused(await run("confirm_booking", ctx), "booking.readBack");
  });

  test("a re-dated pick that dies re-opens the OFFER, and the caller's turn closes it", async () => {
    const ctx = createToolContext();
    expectDialogOk(await run("start_room_booking", ctx));
    expectDialogOk(
      await run("set_stay", { checkIn: "2026-06-15", checkOut: "2026-06-16", guests: 2 }, ctx),
    );
    expectDialogOk(await run("choose_room", { roomType: "penthouse" }, ctx));
    // The penthouse is occupied through June 12.
    const moved = expectDialogOk<{ next: string }>(
      await run("set_stay", { checkIn: "2026-06-10", checkOut: "2026-06-11", guests: 2 }, ctx),
    );
    expect(moved.result.next).toBe("OFFER");
    expect(moved.state).toBe("booking.offering");
    expect(hotelSlot.get(ctx).draft?.roomType).toBeNull();
    // Closed until the options have been spoken and the caller has answered.
    expectDialogRefused(await run("choose_room", { roomType: "king" }, ctx), "booking.offering");
    expect(callerAnswers(ctx)).toBe("booking.room");
    expectDialogOk(await run("choose_room", { roomType: "king" }, ctx));
  });

  test("sold-out dates are refused and NOT recorded", async () => {
    const ctx = createToolContext();
    expectDialogOk(await run("start_room_booking", ctx));
    const refused = await run(
      "set_stay",
      { checkIn: "2026-07-03", checkOut: "2026-07-04", guests: 2 },
      ctx,
    );
    expect(isToolFailure(refused) && refused.error).toMatch(/sold out/);
    expect(hotelSlot.get(ctx).draft?.checkIn).toBeNull();
    expect(at(ctx)).toBe("booking.stay");
  });

  test("a room in a view the type does not have is refused with where the view IS", async () => {
    const ctx = createToolContext();
    expectDialogOk(await run("start_room_booking", ctx));
    expectDialogOk(
      await run("set_stay", { checkIn: "2026-07-14", checkOut: "2026-07-17", guests: 2 }, ctx),
    );
    const refused = await run("choose_room", { roomType: "king", view: "garden" }, ctx);
    expect(isToolFailure(refused) && refused.error).toMatch(/garden view IS open as a queen 2beds/);
  });

  test("a bad card bounces one field and leaves the flow where it was", async () => {
    const ctx = createToolContext();
    await bookUpToReadBack(ctx);
    // Re-record with a misheard digit: refused, and the recorded card stays.
    const refused = await run("record_card", { ...A_CARD, cardNumber: "4532 0000 0001 4472" }, ctx);
    expect(isToolFailure(refused) && refused.error).toMatch(/one digit is likely off/);
    expect(hotelSlot.get(ctx).draft?.cardLast4).toBe("4471");
    expect(at(ctx)).toBe("booking.readBack");
  });

  test("abandoning writes nothing and returns to the desk", async () => {
    const ctx = createToolContext();
    await bookUpToReadBack(ctx);
    const gone = expectDialogOk(
      await run("abandon_booking", { reason: "changed their mind" }, ctx),
    );
    expect(gone.state).toBe("desk");
    expect(hotelSlot.get(ctx).draft).toBeNull();
    expect(hotelSlot.get(ctx).bookings.some((b) => b.lastName === "Whitfield")).toBe(false);
  });

  test("the double-booking guard: no second flow until the caller has spoken again", async () => {
    const ctx = withCallerTurns(4);
    await bookUpToReadBack(ctx);
    callerAnswers(ctx);
    expectDialogOk(await run("confirm_booking", ctx));
    // Same history, so the model — not the caller — is asking for a second room.
    const again = await run("start_room_booking", ctx);
    expect(isToolFailure(again) && again.error).toMatch(/already complete/);
    expect(at(ctx)).toBe("desk");
    // One more caller turn and a real second room is legal.
    const later = withCallerTurns(5);
    hotelSlot.set(
      later,
      structuredClone(hotelSlot.get(ctx)) as Parameters<typeof hotelSlot.set>[1],
    );
    expectDialogOk(await run("start_room_booking", later));
  });

  test("a hang-up ends the call, and nothing books after it", async () => {
    const ctx = createToolContext();
    await bookUpToReadBack(ctx);
    expect(deskFlow.receive(ctx, CALLER_GONE).state).toBe("hungUp");
    expect(isToolFailure(await run("confirm_booking", ctx))).toBe(true);
    expect(isToolFailure(await run("start_room_booking", ctx))).toBe(true);
  });
});

// ─── 5. Modifying a booking ──────────────────────────────────────────────────

describe("modifying a booking", () => {
  test("Robert Klein's garden view is a room MOVE, and the refusal is the fix", async () => {
    const ctx = createToolContext();
    await verify(ctx, "Klein", "HTL-RK20");
    const loaded = expectDialogOk<{ loaded: { room: string; total: string } }>(
      await run("start_booking_modification", ctx),
    );
    expect(loaded.state).toBe("booking.editing");
    expect(loaded.result.loaded.room).toBe("king, city view, room 201");
    expect(loaded.result.loaded.total).toBe("537 dollars and 60 cents");

    // A garden king has never existed; the garden view IS open as a queen.
    const refused = await run("choose_room", { roomType: "king", view: "garden" }, ctx);
    expect(isToolFailure(refused) && refused.error).toMatch(/garden view IS open as a queen 2beds/);

    const picked = expectDialogOk(
      await run("choose_room", { roomType: "queen_2beds", view: "garden" }, ctx),
    );
    expect(picked.state).toBe("booking.readBack");
    expect(callerAnswers(ctx)).toBe("booking.agreeing");
    const done = expectDialogOk<{
      outcome: string;
      changed: string[];
      room: string;
      message: string;
    }>(await run("confirm_booking", ctx));
    expect(done.result).toMatchObject({ outcome: "updated", changed: ["room"], room: "205" });
    // 537.60 → 492.80, the difference refunded, and the model is handed the number.
    expect(done.result.message).toContain("44 dollars and 80 cents refunded");
    const booking = hotelSlot.get(ctx).bookings.find((b) => b.code === "HTL-RK20");
    expect(booking).toMatchObject({ roomId: "205", total: 49_280 });
    // Still verified as the same guest, on the post-modify booking.
    expect(hotelSlot.get(ctx).verifiedCode).toBe("HTL-RK20");
  });

  test("a date-only change keeps the room the guest already has", async () => {
    const ctx = createToolContext();
    await verify(ctx, "Smith", "HTL-AB12");
    expectDialogOk(await run("start_booking_modification", ctx));
    const stay = expectDialogOk(
      await run("set_stay", { checkIn: "2026-06-13", checkOut: "2026-06-16", guests: 2 }, ctx),
    );
    expect(stay.state).toBe("booking.readBack");
    callerAnswers(ctx);
    const done = expectDialogOk<{ changed: string[]; room: string }>(
      await run("confirm_booking", ctx),
    );
    expect(done.result.changed).toEqual(["stay"]);
    expect(done.result.room).toBe("203");
    expect(hotelSlot.get(ctx).bookings.find((b) => b.code === "HTL-AB12")).toMatchObject({
      checkOut: "2026-06-16",
      total: 89_040,
    });
  });

  test("a modification that changes nothing is closed as unchanged, and a cancellation is refused mid-flow", async () => {
    const ctx = createToolContext();
    await verify(ctx, "Smith", "HTL-AB12");
    expectDialogOk(await run("start_booking_modification", ctx));
    // The caller pivots to cancelling: the desk's tools are still legal, but
    // the model is told to close the flow first — which abandon_booking does.
    expectDialogOk(await run("abandon_booking", { reason: "wants to cancel instead" }, ctx));
    expect(at(ctx)).toBe("desk");
    expect(hotelSlot.get(ctx).bookings.find((b) => b.code === "HTL-AB12")?.status).toBe(
      "confirmed",
    );
  });

  test("the unmodifiable: a cancelled or past booking", async () => {
    const ctx = createToolContext();
    await verify(ctx, "Lee", "HTL-GH78");
    const past = await run("start_booking_modification", ctx);
    expect(isToolFailure(past) && past.error).toMatch(/already ended/);
  });
});

// ─── 6. Cancelling and reinstating ───────────────────────────────────────────

describe("cancelling", () => {
  test("outside the window the whole total comes back; inside it one night is kept", async () => {
    const outside = createToolContext();
    await verify(outside, "Smith", "HTL-AB12");
    const full = ok<{ withinWindow: boolean; forfeit: number; refund: number }>(
      await run("cancel_room_booking", outside),
    );
    expect(full).toMatchObject({ withinWindow: false, forfeit: 0, refund: 59_360 });
    expect(hotelSlot.get(outside).bookings.find((b) => b.code === "HTL-AB12")?.status).toBe(
      "cancelled",
    );
    expect(hotelSlot.get(outside).verifiedCode).toBeNull();

    const inside = createToolContext();
    await verify(inside, "Sato", "HTL-BN23");
    const partial = ok<{
      withinWindow: boolean;
      forfeit: number;
      refund: number;
      message: string;
    }>(await run("cancel_room_booking", inside));
    // Room 204 is 220 a night; the forfeit is that rate, never a model's arithmetic.
    expect(partial).toMatchObject({ withinWindow: true, forfeit: 22_000, refund: 54_880 - 22_000 });
    expect(partial.message).toContain("one room-night (220 dollars) is forfeited");
  });

  test("a cancel re-invoked with no caller turn since re-surfaces the outcome", async () => {
    const ctx = withCallerTurns(2);
    await verify(ctx, "Smith", "HTL-AB12");
    ok(await run("cancel_room_booking", ctx));
    const again = ok<{ alreadyCancelled: boolean; message: string }>(
      await run("cancel_room_booking", ctx),
    );
    expect(again.alreadyCancelled).toBe(true);
    expect(again.message).toContain("refund the full 593 dollars and 60 cents");
  });

  test("reinstating brings a cancelled booking back only while its room is free", async () => {
    const ctx = createToolContext();
    const back = ok<{ reinstated: boolean; code: string }>(
      await run("reinstate_booking", { lastName: "Wagner", confirmationCode: "htl fw77" }, ctx),
    );
    expect(back).toMatchObject({ reinstated: true, code: "HTL-FW77" });
    expect(hotelSlot.get(ctx).bookings.find((b) => b.code === "HTL-FW77")?.status).toBe(
      "confirmed",
    );
    expect(hotelSlot.get(ctx).verifiedCode).toBe("HTL-FW77");
    // Already active: a no-op that says so.
    const noop = ok<{ reinstated: boolean }>(
      await run("reinstate_booking", { lastName: "Wagner", confirmationCode: "HTL-FW77" }, ctx),
    );
    expect(noop.reinstated).toBe(false);
  });
});

// ─── 7. Disputes ─────────────────────────────────────────────────────────────

describe("disputes", () => {
  test("the policy table decides the refund, and the refund moves the invoice", async () => {
    const ctx = createToolContext();
    await verify(ctx, "Lee", "HTL-GH78");
    const invoice = ok<{ lineItems: { label: string }[] }>(await run("lookup_invoice", ctx));
    expect(invoice.lineItems.map((li) => li.label)).toContain("Late checkout");

    const filed = ok<{ outcome: string; refund: number; say: string }>(
      await run(
        "dispute_charge",
        {
          category: "late_checkout_fee",
          lineItemLabel: "late checkout",
          callerNote: "Front desk said a 1 PM checkout would be fine.",
          acceptsOfferedResolution: true,
        },
        ctx,
      ),
    );
    expect(filed).toMatchObject({ outcome: "goodwill_waived", refund: PRICING.lateCheckout });
    expect(filed.say).toContain("Waived as a one-time courtesy - 40 dollars back");
    const live = hotelSlot.get(ctx).invoices.find((i) => i.bookingCode === "HTL-GH78");
    // 672.00 less the 40.00 already waived in the seed, less this one.
    expect(live?.total).toBe(67_200 - PRICING.lateCheckout - PRICING.lateCheckout);
  });

  test("a no-show is explained, never refunded, and escalates only when the caller pushes", async () => {
    const ctx = createToolContext();
    await verify(ctx, "Richardson", "HTL-NS44");
    const pushed = ok<{ outcome: string; refund: number }>(
      await run(
        "dispute_charge",
        {
          category: "no_show",
          lineItemLabel: "Room (2 nights)",
          callerNote: "Never showed up.",
          acceptsOfferedResolution: false,
        },
        ctx,
      ),
    );
    expect(pushed).toMatchObject({ outcome: "escalated_to_manager", refund: 0 });
  });

  test("a line item that is not on the invoice is refused with the lines that are", async () => {
    const ctx = createToolContext();
    await verify(ctx, "Lee", "HTL-GH78");
    const refused = await run(
      "dispute_charge",
      {
        category: "minibar",
        lineItemLabel: "Minibar",
        callerNote: "?",
        acceptsOfferedResolution: false,
      },
      ctx,
    );
    expect(isToolFailure(refused) && refused.error).toMatch(/Room \(2 nights\); Late checkout/);
  });

  test("the outcome table, branch by branch", () => {
    const lines = [{ label: "Minibar", amount: 1800 }];
    expect(resolveDisputeOutcome(DISPUTE_POLICIES.minibar, 1800, "Minibar", lines, false)).toEqual({
      outcome: "auto_refunded",
      refund: 1800,
    });
    expect(
      resolveDisputeOutcome(DISPUTE_POLICIES.minibar, 9000, "Minibar", lines, false).outcome,
    ).toBe("escalated_to_manager");
    expect(
      resolveDisputeOutcome(DISPUTE_POLICIES.damage_cleaning, 5000, "Pet fee", lines, true).outcome,
    ).toBe("explained_no_action");
    const doubled = [
      { label: "Room (3 nights)", amount: 66_000 },
      { label: "Room (3 nights)", amount: 66_000 },
    ];
    expect(
      resolveDisputeOutcome(
        DISPUTE_POLICIES.double_charge_billing_error,
        66_000,
        "Room (3 nights)",
        doubled,
        false,
      ),
    ).toEqual({ outcome: "auto_refunded", refund: 66_000 });
    expect(
      resolveDisputeOutcome(
        DISPUTE_POLICIES.double_charge_billing_error,
        66_000,
        "Room (3 nights)",
        lines,
        false,
      ).outcome,
    ).toBe("accounting_ticket_opened");
  });
});

// ─── 8. Room conflicts: the two seeded double-bookings ───────────────────────

describe("room conflicts", () => {
  test("Kenji Tanaka is WALKED: the house is full tonight, and 301 is his again tomorrow", async () => {
    const ctx = createToolContext();
    await verify(ctx, "Tanaka", "HTL-RT88");
    const looked = ok<{ WARNING?: string }>(await run("lookup_booking", ctx));
    expect(looked.WARNING).toMatch(/double-booked/);
    const resolved = ok<{ resolved: string; partnerHotel: string; returnDate: string }>(
      await run("resolve_room_conflict", ctx),
    );
    expect(resolved).toMatchObject({
      resolved: "walked",
      partnerHotel: "the Harbor House",
      returnDate: "Tuesday, June 9",
    });
    expect(hotelSlot.get(ctx).tickets.some((t) => t.kind === "walk")).toBe(true);
    // The booking itself is untouched: same room, same total.
    expect(hotelSlot.get(ctx).bookings.find((b) => b.code === "HTL-RT88")?.roomId).toBe("301");
  });

  test("Tom Whelan is UPGRADED: the only room at or above his rate is a suite, at his total", async () => {
    const ctx = createToolContext();
    await verify(ctx, "Whelan", "HTL-TW55");
    const before = hotelSlot.get(ctx).bookings.find((b) => b.code === "HTL-TW55")?.total;
    const resolved = ok<{
      resolved: string;
      roomType: string;
      upgraded: boolean;
      room: string;
    }>(await run("resolve_room_conflict", ctx));
    expect(resolved).toMatchObject({ resolved: "moved", roomType: "suite", upgraded: true });
    const after = hotelSlot.get(ctx).bookings.find((b) => b.code === "HTL-TW55");
    expect(after?.roomId).toBe(resolved.room);
    expect(after?.total).toBe(before);
    // And the lookup no longer warns.
    expect(ok<{ WARNING?: string }>(await run("lookup_booking", ctx)).WARNING).toBeUndefined();
  });

  test("a booking with no conflict has nothing to resolve", async () => {
    const ctx = createToolContext();
    await verify(ctx, "Klein", "HTL-RK20");
    const refused = await run("resolve_room_conflict", ctx);
    expect(isToolFailure(refused) && refused.error).toMatch(/no room conflict/);
  });
});

// ─── 9. Guest privacy ────────────────────────────────────────────────────────

describe("taking a message", () => {
  test("the result for an in-house guest and for a stranger are indistinguishable", async () => {
    const ctx = createToolContext();
    const args = {
      callerName: "Mark Ellis",
      callerPhone: "415 555 0100",
      message: "Dinner is at eight.",
    };
    const guest = ok<Record<string, unknown>>(
      await run("take_guest_message", { ...args, recipient: "Jonathan Pierce" }, ctx),
    );
    const stranger = ok<Record<string, unknown>>(
      await run("take_guest_message", { ...args, recipient: "Nobody Here" }, ctx),
    );
    const shape = (r: Record<string, unknown>) => Object.keys(r).sort();
    expect(shape(guest)).toEqual(shape(stranger));
    for (const result of [guest, stranger]) {
      // Neither the verdict nor the room number the ledger knows reaches the model.
      expect(JSON.stringify(result)).not.toMatch(/delivered|undeliverable|303/);
    }
    // The desk's ledger knows; the model never did.
    const statuses = hotelSlot
      .get(ctx)
      .tickets.filter((t) => t.kind === "guest_message")
      .map((t) => t.details.status);
    expect(statuses).toEqual(["delivered", "undeliverable"]);
  });

  test("a first name alone is refused — a message needs the full name to reach anyone", async () => {
    const refused = await run("take_guest_message", {
      recipient: "Jonathan",
      callerName: "Mark",
      callerPhone: "415 555 0100",
      message: "hi",
    });
    expect(isToolFailure(refused) && refused.error).toMatch(/last name/);
  });
});

// ─── 10. The restaurant ──────────────────────────────────────────────────────

describe("the restaurant", () => {
  test("open slots come from the tables that seat the party and are not already taken", async () => {
    const open = ok<{ open: string[] }>(
      await run("check_restaurant_availability", { date: TODAY, partySize: 4 }),
    );
    expect(open.open).toContain("7 PM");
    const six = ok<{ open: string[] }>(
      await run("check_restaurant_availability", { date: TODAY, partySize: 6 }),
    );
    // The one six-top is García's at 7:30 tonight.
    expect(six.open).not.toContain("7:30 PM");
    expect(six.open).toContain("7 PM");
  });

  test("a table is booked in one call, and the refusals carry the open times or the transfer", async () => {
    const ctx = createToolContext();
    const args = {
      date: TODAY,
      time: "19:00",
      partySize: 4,
      firstName: "Ana",
      lastName: "Reyes",
      phone: "415 555 0199",
    };
    const booked = ok<{ code: string; time: string }>(await run("reserve_table", args, ctx));
    expect(booked.code).toMatch(/^RES-/);
    expect(booked.time).toBe("7 PM");

    const odd = await run("reserve_table", { ...args, time: "19:15" }, ctx);
    expect(isToolFailure(odd) && odd.error).toMatch(/5:30 PM/);
    const big = await run("reserve_table", { ...args, partySize: 8 }, ctx);
    expect(isToolFailure(big) && big.error).toMatch(/transfer_call/);
    const past = await run("reserve_table", { ...args, date: "2026-06-01" }, ctx);
    expect(isToolFailure(past)).toBe(true);
  });

  test("moving a reservation keeps its table when that table is still free", async () => {
    const ctx = createToolContext();
    const moved = ok<{ code: string; time: string; partySize: number }>(
      await run(
        "modify_restaurant_reservation",
        { lastName: "Bennett", confirmationCode: "RES-JK90", newDate: TODAY, newTime: "19:30" },
        ctx,
      ),
    );
    expect(moved).toMatchObject({ code: "RES-JK90", time: "7:30 PM", partySize: 4 });
    const reservation = hotelSlot.get(ctx).reservations.find((r) => r.code === "RES-JK90");
    expect(reservation).toMatchObject({ tableId: 3, time: "19:30" });

    const cancelled = ok(
      await run(
        "cancel_restaurant_reservation",
        { lastName: "Bennett", confirmationCode: "res jk90" },
        ctx,
      ),
    );
    expect(cancelled).toMatchObject({ cancelled: true });
    expect(
      isToolFailure(
        await run(
          "lookup_restaurant_reservation",
          { lastName: "Bennett", confirmationCode: "RES-JK90" },
          ctx,
        ),
      ),
    ).toBe(true);
  });
});

// ─── 11. Services and the ledger ─────────────────────────────────────────────

describe("services", () => {
  test("an emergency is dispatched with no verification, and the direction matches the kind", async () => {
    const ctx = createToolContext();
    const sent = ok<{ dispatched: boolean; room: string; next: string }>(
      await run(
        "dispatch_emergency",
        { room: "room 401", kind: "medical", situation: "guest collapsed" },
        ctx,
      ),
    );
    expect(sent).toMatchObject({ dispatched: true, room: "401" });
    expect(sent.next).toMatch(/9-1-1/);
    expect(hotelSlot.get(ctx).tickets[0]?.kind).toBe("emergency");
    const badRoom = await run(
      "dispatch_emergency",
      { room: "999", kind: "fire", situation: "smoke" },
      ctx,
    );
    expect(isToolFailure(badRoom) && badRoom.error).toMatch(/no such room/);
  });

  test("a wake-up call is set, a followup is recorded, and each is a ledger line with a reference", async () => {
    const ctx = createToolContext();
    const wake = ok<{ reference: string; when: string }>(
      await run(
        "schedule_wakeup_call",
        { room: "304", guestName: "Frank Adler", date: addDays(TODAY, 1), time: "04:45" },
        ctx,
      ),
    );
    expect(wake.reference).toMatch(/^WUC-/);
    expect(wake.when).toBe("Tuesday, June 9 at 4:45 AM");
    const followup = ok<{ reference: string; next: string }>(
      await run(
        "record_followup",
        {
          kind: "housekeeping",
          callerName: "Priya Nair",
          callerPhone: "202",
          summary: "Two more towels to room 202.",
        },
        ctx,
      ),
    );
    expect(followup.reference).toMatch(/^FUP-/);
    expect(followup.next).toContain("Two more towels");
    expect(deskView(hotelSlot.get(ctx)).ledger.map((t) => t.kind)).toEqual([
      "followup",
      "wakeup_call",
    ]);
  });

  test("a transfer happens exactly once per department", async () => {
    const ctx = createToolContext();
    const first = ok<{ alreadyTransferred: boolean }>(
      await run(
        "transfer_call",
        { destination: "restaurant", summary: "party of ten, private room" },
        ctx,
      ),
    );
    const second = ok<{ alreadyTransferred: boolean }>(
      await run("transfer_call", { destination: "restaurant", summary: "again" }, ctx),
    );
    expect(first.alreadyTransferred).toBe(false);
    expect(second.alreadyTransferred).toBe(true);
    expect(hotelSlot.get(ctx).tickets.filter((t) => t.kind === "transfer")).toHaveLength(1);
  });

  test("the catalogs price a booking and refuse past its caps", async () => {
    const ctx = createToolContext();
    const tour = ok<{ total: string; reference: string }>(
      await run(
        "book_tour",
        {
          tour: "full_day_city",
          date: addDays(TODAY, 2),
          partySize: 2,
          guestName: "Sofía García",
          guestPhone: "415 555 0107",
        },
        ctx,
      ),
    );
    expect(tour.total).toBe("220 dollars");
    expect(tour.reference).toMatch(/^TUR-/);
    const tooMany = await run("book_tour", {
      tour: "private_city",
      date: addDays(TODAY, 2),
      partySize: 5,
      guestName: "x",
      guestPhone: "1",
    });
    expect(isToolFailure(tooMany) && tooMany.error).toMatch(/at most 4/);
    const past = await run("order_flowers", {
      arrangement: "roses",
      date: "2026-06-01",
      deliverTo: "401",
      cardMessage: "Happy anniversary",
      guestName: "x",
      guestPhone: "1",
    });
    expect(isToolFailure(past) && past.error).toMatch(/in the past/);
    const spa = ok<{ total: string }>(
      await run(
        "book_spa_appointment",
        {
          service: "deep_tissue_massage",
          date: addDays(TODAY, 1),
          time: "10:00",
          partySize: 2,
          guestName: "x",
          guestPhone: "1",
        },
        ctx,
      ),
    );
    expect(spa.total).toBe("280 dollars");
    const biz = ok<{ total: string }>(
      await run(
        "book_business_center",
        {
          service: "meeting_room",
          date: addDays(TODAY, 1),
          time: "09:00",
          durationHours: 3,
          guestName: "x",
          guestPhone: "1",
        },
        ctx,
      ),
    );
    expect(biz.total).toBe("120 dollars");
  });

  test("the policy book renders the catalogs, so a price lives in one place", async () => {
    const tours = ok<{ policy: string }>(await run("lookup_policy", { topic: "tours" }));
    expect(tours.policy).toContain("Half-day city highlights");
    expect(tours.policy).toContain("65 dollars per person");
    expect(POLICIES.spa.body).toContain("140 dollars per person");
    expect(
      await toolInputIssues(agentDef, "lookup_policy", { topic: "not_a_topic" }),
    ).toBeDefined();
  });

  test("a group under fifteen is not a group, and a car with five is not the hotel car", async () => {
    expect(
      await toolInputIssues(agentDef, "record_group_inquiry", {
        company: "Acme",
        contactName: "A",
        contactPhone: "1",
        partySize: 10,
        shareType: "twin",
        checkIn: addDays(TODAY, 30),
        nights: 2,
      }),
    ).toBeDefined();
    expect(
      await toolInputIssues(agentDef, "book_airport_car", {
        room: "401",
        pickupDate: addDays(TODAY, 1),
        pickupTime: "06:00",
        passengers: 5,
      }),
    ).toBeDefined();
    const car = ok<{ total: string }>(
      await run("book_airport_car", {
        room: "401",
        pickupDate: addDays(TODAY, 1),
        pickupTime: "06:00",
        passengers: 3,
      }),
    );
    expect(car.total).toBe("85 dollars");
  });

  test("a flight reference is normalized the way a caller spells one", async () => {
    const ctx = createToolContext();
    ok(
      await run(
        "request_flight_reconfirmation",
        {
          room: "304",
          airline: "Iberia",
          flightNumber: "ib 6174",
          flightDate: addDays(TODAY, 3),
          bookingReference: "x 7 q - 9 2 k",
          seatCheck: true,
        },
        ctx,
      ),
    );
    expect(hotelSlot.get(ctx).tickets[0]?.details).toMatchObject({
      flightNumber: "IB6174",
      bookingReference: "X7Q92K",
    });
  });

  test("the verified guest's extras: a late arrival, a re-sent folio, a new card", async () => {
    const ctx = createToolContext();
    await verify(ctx, "Smith", "HTL-AB12");
    ok(await run("flag_late_arrival", { note: "around 1 AM" }, ctx));
    expect(hotelSlot.get(ctx).bookings.find((b) => b.code === "HTL-AB12")?.lateArrivalNote).toBe(
      "around 1 AM",
    );
    const sent = ok<{ to: string }>(await run("resend_confirmation", { kind: "folio" }, ctx));
    expect(sent.to).toBe("eleanor.smith@gmail.com");
    const card = ok<{ cardLast4: string }>(await run("update_card", A_CARD, ctx));
    expect(card.cardLast4).toBe("4471");
    expect(hotelSlot.get(ctx).bookings.find((b) => b.code === "HTL-AB12")?.cardLast4).toBe("4471");
  });

  test("two contexts never share a hotel", async () => {
    const a = createToolContext();
    const b = createToolContext();
    await verify(a, "Smith", "HTL-AB12");
    ok(await run("cancel_room_booking", a));
    expect(hotelSlot.get(b).bookings.find((x) => x.code === "HTL-AB12")?.status).toBe("confirmed");
  });
});
