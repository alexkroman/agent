import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { bookingStatus, nextStep, requote } from "../booking.ts";
import { AFTER_STAY, deskFlow } from "../desk.ts";
import { describeRoomOptions, listRoomOptions } from "../hotel.ts";
import { daysBetween, describeExtras, ROOM_TYPES, ROOM_VIEWS, speakUsd } from "../records.ts";
import { hotelSlot } from "../session.ts";

/**
 * Record the room type (and view) the caller picked from the options `set_stay`
 * returned — their `choose_room`, on both tasks.
 *
 * A stated view narrows WHICH room of that type they get; it does not pick the
 * type. When that view is not available for the type, the refusal says where
 * the view IS available — and in a modification that sentence is the whole fix
 * for a guest unhappy with their room: the garden view is open as a queen, so
 * offer the queen rather than a manager callback.
 */
export default deskFlow.tool({
  description:
    "Record the room type the caller chose from the options set_stay returned, and the view if " +
    "they stated one. Call ONLY after the caller has named a type. The result lists the extras to " +
    "offer next - there is no total yet.",
  when: AFTER_STAY,
  inputSchema: z.object({
    roomType: z.enum(ROOM_TYPES).describe("Exactly as the caller chose it"),
    smokingRoom: z
      .boolean()
      .optional()
      .describe("True only if the caller asked for a smoking-permitted room"),
    view: z.enum(ROOM_VIEWS).optional().describe("ONLY if the caller stated one - omit otherwise"),
  }),
  execute: ({ roomType, smokingRoom, view }, ctx) =>
    hotelSlot.update(ctx, (hotel) => {
      // Non-smoking unless asked: industry-standard opt-in, not a value the
      // caller has to volunteer.
      const smoking = smokingRoom ?? false;
      const d = hotel.draft;
      if (d === null)
        return toolFailure("No booking flow is open - call start_room_booking first.");
      if (d.checkIn === null || d.checkOut === null || d.guests === null) {
        return toolFailure("stay dates and guest count not yet recorded - call set_stay first");
      }
      const avail = listRoomOptions(hotel, {
        checkIn: d.checkIn,
        checkOut: d.checkOut,
        guests: d.guests,
        smoking,
        excludeCode: d.existingCode,
      });
      const forType = avail.filter((a) => a.type === roomType);
      if (forType.length === 0) {
        const offer =
          [...new Set(avail.map((a) => a.type.replaceAll("_", " ")))].join(", ") ||
          "nothing for those dates";
        return toolFailure(
          `no ${smoking ? "smoking " : ""}${roomType.replaceAll("_", " ")} available; offer one of: ${offer}`,
        );
      }
      const wanted = view ?? null;
      if (wanted !== null && !forType.some((a) => a.view === wanted)) {
        const elsewhere = [...new Set(avail.filter((a) => a.view === wanted).map((a) => a.type))];
        if (elsewhere.length > 0) {
          const rec = elsewhere.map((t) => t.replaceAll("_", " ")).join(" or ");
          return toolFailure(
            `no ${wanted}-view ${roomType.replaceAll("_", " ")} for those dates, but the ${wanted} view IS ` +
              `open as a ${rec} - that is the real fix here. Offer it warmly as "the ${wanted}-view room ` +
              'available for your dates", then call choose_room again with that type and view.',
          );
        }
        return toolFailure(
          `no ${wanted}-view room of any type for those dates - the pairings open are:\n` +
            `${describeRoomOptions(avail)}\nBe honest that the exact view isn't open, and offer the closest option.`,
        );
      }
      d.roomType = roomType;
      d.view = wanted;
      d.smoking = smoking;
      requote(hotel, d);
      const rate = Math.min(
        ...forType.filter((a) => wanted === null || a.view === wanted).map((a) => a.nightlyRate),
      );
      const nights = daysBetween(d.checkIn, d.checkOut);
      return {
        recorded: `${roomType.replaceAll("_", " ")}${wanted ? ` with a ${wanted} view` : ""} at ${speakUsd(rate)} a night`,
        extrasToOffer: describeExtras(nights),
        note: "offer these and get an answer before any total, since each one moves it",
        status: bookingStatus(d),
        next: nextStep(d),
      };
    }),
  sendFrom: (result) => ({ type: result.next }),
});
