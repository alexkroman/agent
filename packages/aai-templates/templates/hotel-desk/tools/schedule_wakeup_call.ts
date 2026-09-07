import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { requireRoom } from "../hotel.ts";
import { isoDate, speakCode, spokenDate, spokenTime, TODAY } from "../records.ts";
import { addTicket, hotelSlot } from "../shared.ts";

/** Their `schedule_wakeup_call`: it actually sets the call — never a followup note instead. */
export default hotelSlot.updateTool({
  description:
    "Schedule a wake-up call to a guest's room. This actually sets the call - never log a wake-up " +
    "as a followup. Collect room, name, date and time, read them back, then call once agreed. No " +
    "booking verification needed.",
  inputSchema: z.object({
    room: z.string().describe("The room number as the caller gave it, e.g. 304"),
    guestName: z.string().min(1),
    date: isoDate("the date").describe("YYYY-MM-DD; 'tomorrow morning' is tomorrow's date"),
    time: z.string().describe("24-hour HH:MM; 4:45 a.m. is 04:45"),
  }),
  execute({ room, guestName, date, time }, hotel) {
    const found = requireRoom(hotel, room);
    if ("error" in found) return toolFailure(found.error);
    if (date < TODAY)
      return toolFailure(`${spokenDate(date)} is in the past - re-confirm the date`);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
      return toolFailure("the time must be 24-hour HH:MM");
    const ticket = addTicket(
      hotel,
      "wakeup_call",
      "WUC",
      `room ${found.id}, ${date} ${time} (${guestName})`,
      {
        room: found.id,
        guestName,
        date,
        time,
        status: "scheduled",
      },
    );
    return {
      scheduled: true,
      reference: ticket.code,
      spokenReference: speakCode(ticket.code),
      when: `${spokenDate(date)} at ${spokenTime(time)}`,
      room: found.id,
      next:
        "Confirm it's set. If the caller worries about sleeping through: a second call comes about five " +
        "minutes later if there's no answer, and no response to that sends staff up for an in-person room check.",
    };
  },
});
