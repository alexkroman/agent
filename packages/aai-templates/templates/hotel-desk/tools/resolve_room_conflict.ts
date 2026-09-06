import { toolFailure } from "@alexkroman1/aai";
import { resolveRoomConflict } from "../hotel.ts";
import { spokenDate } from "../records.ts";
import { hotelSlot, requireVerified } from "../shared.ts";

/**
 * Fix a double-booked room on the verified booking — their
 * `resolve_room_conflict`, running the house procedure in fixed order: a free
 * room of the same or better category (an upgrade is free), and only when the
 * house is full, a walk to the partner hotel on us.
 */
export default hotelSlot.updateTool({
  description:
    "Fix a double-booked / no-room situation on the verified booking - run this when lookup_booking " +
    "warned the room is double-booked. Moves the guest to a same-or-better room for free, or when " +
    "nothing in the house fits, arranges the walk (partner hotel tonight on us, taxi covered, their " +
    'room back from the return date). Deliver the result per lookup_policy "guest_walks".',
  execute(_args, hotel) {
    const booking = requireVerified(hotel);
    if ("error" in booking) return toolFailure(booking.error);
    const resolution = resolveRoomConflict(hotel, booking.code);
    if ("error" in resolution) return toolFailure(resolution.error);
    if (resolution.kind === "moved") {
      return {
        resolved: "moved" as const,
        room: resolution.roomId,
        roomType: resolution.type.replaceAll("_", " "),
        view: resolution.view,
        upgraded: resolution.upgraded,
        message:
          `Moved to room ${resolution.roomId} - a ${resolution.view}-view ${resolution.type.replaceAll("_", " ")} ` +
          `(${resolution.upgraded ? "an upgrade, free of charge" : "same category, no charge"}), same dates, total unchanged. ` +
          "Own the overbooking and explain plainly why it happened, then confirm they still have a place for the whole " +
          "stay at the same total. No further tool call is needed.",
      };
    }
    return {
      resolved: "walked" as const,
      partnerHotel: resolution.partner,
      returnDate: spokenDate(resolution.returnDate),
      message:
        `No room in the house fits (every room was checked) - walk arranged at ${resolution.partner}, two blocks ` +
        `away, room and taxi both on us; the guest's room here is back ${spokenDate(resolution.returnDate)}. Own the ` +
        "overbooking, explain plainly why it happened, then the plan above, all at no extra cost to them. Give it in " +
        'short pieces. If still upset after the full plan, record a manager callback (record_followup, kind "callback").',
    };
  },
});
