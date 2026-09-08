import { isToolFailure } from "@alexkroman1/aai";
import { roomConflict } from "../hotel.ts";
import { daysBetween, speakUsd, spokenDate } from "../records.ts";
import { hotelSlot, requireVerified } from "../shared.ts";

/**
 * Read-only lookup of the verified booking — their `lookup_booking`, including
 * the WARNING it carried: if another confirmed booking holds this room for an
 * overlapping window, the result says so and names `resolve_room_conflict`, so
 * the desk does not read a guest a booking that has no room behind it.
 */
export default hotelSlot.tool({
  description:
    "Read the verified caller's booking back: dates, room, guests, extras, total, card. Changes " +
    "nothing. Verify first with verify_booking.",
  execute(_args, hotel) {
    const b = requireVerified(hotel);
    if (isToolFailure(b)) return b;
    const room = hotel.rooms.find((r) => r.id === b.roomId);
    const nights = daysBetween(b.checkIn, b.checkOut);
    const conflict = roomConflict(hotel, b.code);
    return {
      code: b.code,
      guest: `${b.firstName} ${b.lastName}`,
      status: b.status,
      room: room
        ? `${room.type.replaceAll("_", " ")}, ${room.view} view, ${room.smoking ? "smoking-permitted" : "non-smoking"}`
        : b.roomId,
      checkIn: spokenDate(b.checkIn),
      checkOut: spokenDate(b.checkOut),
      nights,
      guests: b.guests,
      extras:
        b.extras.length > 0 ? b.extras.map((e) => e.replaceAll("_", " ")).join(", ") : "no extras",
      total: speakUsd(b.total),
      cardLast4: b.cardLast4,
      lateArrivalNote: b.lateArrivalNote,
      ...(conflict
        ? {
            WARNING:
              `the room is double-booked ${spokenDate(conflict.from)} to ${spokenDate(conflict.to)} - no room is ` +
              "assigned to this booking for that period. Break the news with ownership and an apology, then run " +
              'resolve_room_conflict to fix it (procedure: lookup_policy topic "guest_walks"). Don\'t pretend the booking is fine.',
          }
        : {}),
    };
  },
});
