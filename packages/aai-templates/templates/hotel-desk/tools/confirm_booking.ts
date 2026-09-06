import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { bookingStatus, changedFields, nextStep } from "../booking.ts";
import { deskFlow } from "../desk.ts";
import { bookRoom, updateBooking } from "../hotel.ts";
import { speakCode, speakUsd } from "../records.ts";
import { bookingByCode, callerTurns, hotelSlot, note } from "../shared.ts";

/**
 * Finalize the booking — their `confirm_booking` and `confirm_changes`, one
 * tool because the draft's `mode` says which write it makes.
 *
 * Gated on `booking.agreeing`, which is reachable only from the read-back and
 * only by the caller's next committed turn — so this cannot run before the
 * booking has been read back AND answered. Their `_closed()` refused it before
 * `AWAIT_AGREEMENT` with a sentence naming the outcome ("nothing was recorded,
 * no booking was made, and no confirmation code exists") because a bare "do X
 * next" was relayed to the caller as though the call had gone through; the SDK's
 * refusal quotes the state's instruction, which says the same thing.
 *
 * **A room taken between the read-back and the confirm is a MOVE, not a
 * failure.** Their flow cleared the room and returned "pick another room or
 * shift the dates; I've kept everything else". A `ToolFailure` would send no
 * event and leave the position at `agreeing` with no room on the draft, so this
 * answers a success shape with `next: "NEED_ROOM"` and lets `sendFrom` land the
 * flow where the caller has to pick again.
 */
export default deskFlow.tool({
  description:
    "Finalize the booking and charge the card, or write a modification back. Call ONLY after " +
    "the caller has agreed to your read-back. Returns the final confirmation - relay the code " +
    "and total and move on; nothing further to confirm or call.",
  when: "booking.agreeing",
  inputSchema: z.object({}),
  execute: (_args, ctx) =>
    hotelSlot.update(ctx, (hotel) => {
      const d = hotel.draft;
      if (d === null)
        return toolFailure("No booking flow is open - call start_room_booking first.");
      if (nextStep(d) !== "READ_BACK") return toolFailure(bookingStatus(d));
      // `nextStep` proved every one of these non-null; the narrowing is for the compiler.
      if (
        !(
          d.checkIn &&
          d.checkOut &&
          d.guests &&
          d.roomType &&
          d.firstName &&
          d.lastName &&
          d.email &&
          d.phone &&
          d.cardLast4
        )
      ) {
        return toolFailure(bookingStatus(d));
      }

      if (d.mode === "modify" && d.existingCode !== null) {
        const before = bookingByCode(hotel, d.existingCode);
        const room =
          before === undefined ? undefined : hotel.rooms.find((r) => r.id === before.roomId);
        if (before === undefined || room === undefined)
          return toolFailure(`booking ${d.existingCode} vanished mid-modification`);
        const changed = changedFields(d, before, room);
        if (changed.length === 0) {
          hotel.draft = null;
          return {
            outcome: "unchanged" as const,
            message:
              "Booking left unchanged. The modification flow is closed - if the caller wants to " +
              "cancel instead, call cancel_room_booking now.",
            next: "BOOKED" as const,
          };
        }
        const previousTotal = before.total;
        const updated = updateBooking(hotel, d.existingCode, {
          roomType: d.roomType,
          smoking: d.smoking,
          view: d.view,
          guests: d.guests,
          checkIn: d.checkIn,
          checkOut: d.checkOut,
          extras: d.extras,
        });
        if ("error" in updated) {
          d.roomType = null;
          d.view = null;
          return {
            outcome: "room_taken" as const,
            message: `${updated.error} - pick another room or adjust the dates; everything else is kept.`,
            next: "NEED_ROOM" as const,
          };
        }
        hotel.draft = null;
        const delta = updated.total - previousTotal;
        const money =
          delta === 0
            ? `total stays at ${speakUsd(updated.total)}`
            : `new total is ${speakUsd(updated.total)}; ${speakUsd(Math.abs(delta))} ${delta > 0 ? "added to" : "refunded to"} the card ending in ${updated.cardLast4}`;
        return {
          outcome: "updated" as const,
          changed,
          room: updated.roomId,
          message: `Your booking is updated; ${money}. Relay what changed, the new total, and any amount added or refunded.`,
          next: "BOOKED" as const,
        };
      }

      const booking = bookRoom(hotel, {
        roomType: d.roomType,
        smoking: d.smoking,
        view: d.view,
        guests: d.guests,
        checkIn: d.checkIn,
        checkOut: d.checkOut,
        firstName: d.firstName,
        lastName: d.lastName,
        email: d.email,
        phone: d.phone,
        cardLast4: d.cardLast4,
        extras: d.extras,
      });
      if ("error" in booking) {
        d.roomType = null;
        d.view = null;
        return {
          outcome: "room_taken" as const,
          message:
            "That room just got booked - pick another room or shift the dates; everything else is kept.",
          next: "NEED_ROOM" as const,
        };
      }
      hotel.draft = null;
      hotel.lastBooking = { code: booking.code, callerTurns: callerTurns(ctx.messages) };
      note(hotel, `Confirmation email would go to ${booking.email} for ${booking.code}`);
      return {
        outcome: "booked" as const,
        code: booking.code,
        spokenCode: speakCode(booking.code),
        room: booking.roomId,
        total: speakUsd(booking.total),
        cardLast4: booking.cardLast4,
        email: booking.email,
        message:
          `You're booked. Your confirmation code is ${speakCode(booking.code)}. Total is ` +
          `${speakUsd(booking.total)}, charged to the card ending in ${booking.cardLast4}. A ` +
          `confirmation email is on its way to ${booking.email}. Relay the code and total; no ` +
          "further tool call is needed for this booking.",
        next: "BOOKED" as const,
      };
    }),
  sendFrom: (result) => ({ type: result.next }),
});
