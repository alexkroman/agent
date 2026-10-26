/**
 * The four seams a tool call does not run along.
 *
 * `agent.test.ts` drives the desk through its tools — a call in, forty-one
 * tools, what is on the slot afterwards. Everything here is a rule that holds
 * BETWEEN those calls, and each one is invisible from inside a tool body:
 *
 * - the hang-up, which no tool can observe because the caller is gone —
 *   `hungUp`'s `onEnter` in `desk.ts`;
 * - the turn where the model owes SPEECH, so the right number of tools is zero
 *   — `toolChoice: "none"` on `offering` and `readBack`;
 * - a refusal made once and passed along, rather than unpacked and rebuilt at
 *   every hop — `verified`, `requireConfirmedBooking`, `validateCard`, and the
 *   `failable` writers that forward them;
 * - a reference the caller SPOKE — an ordinal off a folio, a code with the word
 *   "dash" in it, a room number with the word "room" — which is a fact about
 *   phones rather than about any one tool.
 *
 * Split from `agent.test.ts` rather than added to it: that file is the tour of
 * the desk, and these are the properties it would bury.
 */

import agentDef from "virtual:aai/agent";
import type { InferToolInput, ToolContext } from "@alexkroman1/aai";
import { isToolFailure, resolveOne } from "@alexkroman1/aai";
import {
  createToolContext,
  expectDialogOk,
  fireEvent,
  sessionEvent,
} from "@alexkroman1/aai-runtime/testing";
import { describeAgent } from "@alexkroman1/aai-runtime/testing/vitest";
import { describe, expect, test } from "vitest";
import { validateCard } from "./card.ts";
import { deskFlow } from "./desk.ts";
import { LINE_ITEM_PICK } from "./disputes.ts";
import {
  cancelBooking,
  requireConfirmedBooking,
  requireRoom,
  resolveRoomConflict,
} from "./hotel.ts";
import { PRICING } from "./records.ts";
import { hotelSlot } from "./session.ts";
import { verified } from "./shared.ts";
import bookSpaAppointment from "./tools/book_spa_appointment.ts";
import chooseRoom from "./tools/choose_room.ts";
import disputeCharge from "./tools/dispute_charge.ts";
import lookupInvoice from "./tools/lookup_invoice.ts";
import lookupRestaurantReservation from "./tools/lookup_restaurant_reservation.ts";
import orderFlowers from "./tools/order_flowers.ts";
import recordCard from "./tools/record_card.ts";
import recordGuestDetails from "./tools/record_guest_details.ts";
import setExtras from "./tools/set_extras.ts";
import setStay from "./tools/set_stay.ts";
import startRoomBooking from "./tools/start_room_booking.ts";
import verifyBooking from "./tools/verify_booking.ts";

describeAgent(agentDef, (run) => {
  /** The event the runtime delivers when the caller is gone. */
  const CALLER_GONE = sessionEvent("session.timedOut");

  /** The caller is gone: the dialog moves to `hungUp`, and `onEnter` writes the lead. */
  const hangUp = async (ctx: ToolContext) => {
    // Driven as the session drives it: the declared dialog is offered the
    // event, and the move is read back off the position.
    await fireEvent(agentDef, CALLER_GONE, ctx);
    const { state } = deskFlow.position(ctx);
    if (state !== "hungUp") throw new Error(`the hang-up landed on ${state}`);
    return hotelSlot.get(ctx).tickets.at(-1);
  };

  /**
   * The card fixture, typed by the TOOL rather than restated.
   *
   * `InferToolInput` reads `record_card`'s own schema, so a field renamed or
   * added there fails HERE at compile time — where `run(recordCard, …)` takes
   * an untyped record and a stale fixture would only surface as a refusal three
   * assertions later.
   */
  const A_CARD: InferToolInput<typeof recordCard> = {
    cardNumber: "4532 0000 0001 4471",
    expiryMonth: 12,
    expiryYear: 29,
    securityCode: "321",
    cardholderName: "Maria Whitfield",
  };

  /** A booking flow open and carrying a name, a phone and a card. */
  async function bookUpToCard(ctx: ToolContext) {
    expectDialogOk(await run(startRoomBooking, ctx));
    expectDialogOk(
      await run(setStay, { checkIn: "2026-07-14", checkOut: "2026-07-17", guests: 2 }, ctx),
    );
    expectDialogOk(await run(chooseRoom, { roomType: "queen_2beds", view: "garden" }, ctx));
    expectDialogOk(
      await run(
        setExtras,
        { breakfast: true, valet: false, lateCheckout: false, pets: false },
        ctx,
      ),
    );
    expectDialogOk(
      await run(
        recordGuestDetails,
        {
          firstName: "Maria",
          lastName: "Whitfield",
          email: "maria.whitfield@gmail.com",
          phone: "123-555-0170",
        },
        ctx,
      ),
    );
  }

  // ─── The hang-up ─────────────────────────────────────────────────────────────

  describe("a hang-up mid-booking leaves a lead behind", () => {
    test("the followup carries who they were and how far they got", async () => {
      const ctx = createToolContext();
      await bookUpToCard(ctx);

      const ticket = await hangUp(ctx);
      expect(ticket?.kind).toBe("followup");
      expect(ticket?.summary).toBe("abandoned_booking: Maria Whitfield dropped mid-booking");
      expect(ticket?.details).toMatchObject({
        kind: "abandoned_booking",
        callerName: "Maria Whitfield",
        callerPhone: "1235550170",
        status: "open",
      });
      // The step they never reached is the one a human has to finish.
      expect(String(ticket?.details.summary)).toContain("take the card");

      const hotel = hotelSlot.get(ctx);
      // The draft is gone, so the sidebar stops claiming a booking is in progress,
      // and the ledger entry is what replaces it.
      expect(hotel.draft).toBeNull();
      expect(hotel.log.at(-1)).toBe(
        "followup: abandoned_booking: Maria Whitfield dropped mid-booking",
      );
    });

    test("a call that ends at the desk writes no followup, only the log line", async () => {
      const ctx = createToolContext();
      expect(await hangUp(ctx)).toBeUndefined();
      const hotel = hotelSlot.get(ctx);
      expect(hotel.tickets).toEqual([]);
      expect(hotel.log).toEqual(["Caller gone - call ended"]);
    });

    test("a caller who gave no name still leaves a callable ticket", async () => {
      const ctx = createToolContext();
      expectDialogOk(await run(startRoomBooking, ctx));
      const ticket = await hangUp(ctx);
      expect(ticket?.details).toMatchObject({
        callerName: "name not given",
        callerPhone: "no number",
      });
      expect(String(ticket?.details.summary)).toContain("ask the caller for dates");
    });

    test("the agent declares the dialog, so the runtime delivers the hang-up to it", () => {
      // `agent({ dialogs })` is what routes `@session.timedOut` to `deskFlow`;
      // without it `hungUp` is never entered and the lead is never written.
      expect(agentDef.dialogs).toContain(deskFlow);
    });
  });

  // ─── Owing SPEECH means no tool at all ───────────────────────────────────────

  describe("the two owed-speech states forbid every tool, not just the gated one", () => {
    test("readBack and offering hand the model no tools; every other state does", async () => {
      const ctx = createToolContext();
      await bookUpToCard(ctx);
      expect(deskFlow.position(ctx).state).toBe("booking.card");
      expect(deskFlow.voiceConfig(ctx)?.toolChoice).toBeUndefined();

      expectDialogOk(await run(recordCard, A_CARD, ctx));
      expect(deskFlow.position(ctx).state).toBe("booking.readBack");
      expect(deskFlow.voiceConfig(ctx)?.toolChoice).toBe("none");

      // The caller answers; the obligation is discharged and the tools come back.
      expect(
        deskFlow.receive(ctx, {
          type: "userTranscript.committed",
          text: "yes, that's right",
          meta: { id: "evt_2", at: 0 },
        }).state,
      ).toBe("booking.agreeing");
      expect(deskFlow.voiceConfig(ctx)?.toolChoice).toBeUndefined();
    });

    test("a re-dated stay that kills the pick lands on offering, which is also speech-only", async () => {
      const ctx = createToolContext();
      expectDialogOk(await run(startRoomBooking, ctx));
      expectDialogOk(
        await run(setStay, { checkIn: "2026-06-15", checkOut: "2026-06-16", guests: 2 }, ctx),
      );
      expectDialogOk(await run(chooseRoom, { roomType: "penthouse" }, ctx));
      // The penthouse is occupied through June 12, so the pick does not survive.
      expectDialogOk(
        await run(setStay, { checkIn: "2026-06-10", checkOut: "2026-06-11", guests: 2 }, ctx),
      );
      expect(deskFlow.position(ctx).state).toBe("booking.offering");
      // `choose_room`'s `when` already refuses here (`agent.test.ts` pins that).
      // What this adds is that NO other tool can be reached either, so the turn
      // ends in the sentence that offers the options rather than in a tool result.
      expect(deskFlow.voiceConfig(ctx)?.toolChoice).toBe("none");
    });
  });

  // ─── The failure vocabulary the tools forward ────────────────────────────────

  describe("a refusal is one object, made once and passed along", () => {
    test("the helpers answer a ToolFailure the tools return unchanged", () => {
      const ctx = createToolContext();
      const hotel = hotelSlot.get(ctx);

      const unverified = verified(hotel);
      expect(isToolFailure(unverified) && unverified.error).toContain("Not verified yet");

      const missing = requireConfirmedBooking(hotel, "HTL-NOPE");
      expect(isToolFailure(missing) && missing.error).toBe("booking not found: HTL-NOPE");

      const badCard = validateCard({ ...A_CARD, cardNumber: "4532 0000 0001 4472" });
      expect(isToolFailure(badCard) && badCard.error).toContain("fails the card check");
    });

    test("`failable` forwards the lookup's refusal and writes nothing", () => {
      hotelSlot.update(createToolContext(), (hotel) => {
        const before = hotel.log.length;
        // A cancelled booking is not a CONFIRMED one: the lookup refuses, `orFail`
        // abandons the body, and the "Cancelled …" log line is never written.
        expect(isToolFailure(cancelBooking(hotel, "HTL-XC91"))).toBe(true);
        expect(isToolFailure(resolveRoomConflict(hotel, "HTL-XC91"))).toBe(true);
        expect(hotel.log.length).toBe(before);

        // And a real one still gets through, with the log line to prove it.
        const cancelled = cancelBooking(hotel, "HTL-GH78");
        expect(isToolFailure(cancelled)).toBe(false);
        expect(hotel.log.at(-1)).toBe("Cancelled HTL-GH78");
      });
    });
  });

  // ─── One rule for reading a spoken reference ─────────────────────────────────

  describe("a spoken reference is resolved, never guessed", () => {
    test("the disputed line is picked by ordinal off the folio just read out", async () => {
      const ctx = createToolContext();
      await run(verifyBooking, { lastName: "Lee", confirmationCode: "HTL-GH78" }, ctx);
      const lines = await run(lookupInvoice, ctx);
      if (isToolFailure(lines)) throw new Error(`lookup_invoice refused: ${lines.error}`);
      expect(lines.lineItems[1]?.label).toBe("Late checkout");

      const byOrdinal = await run(
        disputeCharge,
        {
          category: "late_checkout_fee",
          lineItemLabel: "the second one",
          callerNote: "Front desk said 1 PM was fine.",
          acceptsOfferedResolution: true,
        },
        ctx,
      );
      expect(byOrdinal).toMatchObject({ outcome: "goodwill_waived", refund: PRICING.lateCheckout });
    });

    test("a word that names two lines is REFUSED rather than picked between", () => {
      const folio = [
        { label: "Room (2 nights)", amount: 56_000 },
        { label: "Room service", amount: 4200 },
      ];
      const ambiguous = resolveOne(folio, "the room charge", LINE_ITEM_PICK);
      expect(isToolFailure(ambiguous) && ambiguous.error).toMatch(
        /matches 2 invoice lines.*Room \(2 nights\).*Room service/,
      );
      // The same scorer picks a single winner once a second word narrows it.
      expect(resolveOne(folio, "the room service charge", LINE_ITEM_PICK)).toEqual(folio[1]);
    });

    test('"R E S dash J K nine zero" finds RES-JK90, and so does res jk90', async () => {
      const ctx = createToolContext();
      for (const spoken of ["RES-JK90", "res jk90", "R E S dash J K 9 0"]) {
        const found = await run(
          lookupRestaurantReservation,
          { lastName: "Bennett", confirmationCode: spoken },
          ctx,
        );
        expect(isToolFailure(found)).toBe(false);
        expect((found as { code: string }).code).toBe("RES-JK90");
      }
    });

    test("a spoken room number is read by the same rule", () => {
      const hotel = hotelSlot.get(createToolContext());
      for (const spoken of ["304", "room 304", "Room-304"]) {
        const room = requireRoom(hotel, spoken);
        expect(isToolFailure(room)).toBe(false);
        expect((room as { id: string }).id).toBe("304");
      }
      expect(isToolFailure(requireRoom(hotel, "999"))).toBe(true);
    });
  });

  // ─── The catalog factory's shared checks ─────────────────────────────────────

  describe("the catalog factory checks the date AND the time", () => {
    test("a spa booking at an impossible time is refused before it is priced", async () => {
      const ctx = createToolContext();
      const refused = await run(
        bookSpaAppointment,
        {
          service: "deep_tissue_massage",
          date: "2026-06-20",
          time: "25:00",
          partySize: 1,
          guestName: "Maria Whitfield",
          guestPhone: "1235550170",
        },
        ctx,
      );
      expect(isToolFailure(refused) && refused.error).toBe(
        "25:00 is not a time - use HH:MM on the 24-hour clock",
      );
      expect(hotelSlot.get(ctx).tickets).toEqual([]);
    });

    test("a catalog with no time of its own is unaffected", async () => {
      const ctx = createToolContext();
      const ordered = await run(
        orderFlowers,
        {
          arrangement: "bouquet",
          date: "2026-06-20",
          deliverTo: "301",
          cardMessage: "Happy anniversary",
          guestName: "Maria Whitfield",
          guestPhone: "1235550170",
        },
        ctx,
      );
      expect(isToolFailure(ordered)).toBe(false);
      expect(hotelSlot.get(ctx).tickets.at(-1)?.kind).toBe("flowers");
    });
  });
});
