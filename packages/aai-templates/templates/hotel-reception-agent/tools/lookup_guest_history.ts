import { z } from "zod";
import { hotelSlot } from "../session.ts";

/** Their `lookup_guest_history`: a returning guest's remembered preferences, or none. */
export default hotelSlot.tool({
  description:
    'Look up a returning guest\'s preferences from past stays ("I\'ve stayed before", "booking ' +
    'another stay") so you can offer to set them up again. Only ever surface what this returns - ' +
    "never invent a preference - and only for the guest themselves.",
  inputSchema: z.object({ lastName: z.string().min(1) }),
  execute({ lastName }, hotel) {
    const wanted = lastName.trim().toLowerCase();
    const history = hotel.guestHistory.find((g) => g.lastName.toLowerCase() === wanted);
    if (history === undefined) {
      return {
        onFile: null,
        message:
          "No guest history on file for that name - treat them as a new guest and don't invent past preferences.",
      };
    }
    return {
      onFile: history.preferences,
      message:
        "Proactively offer to set these up again for the new stay, and apply or note the ones the guest " +
        "confirms. Don't add any preference beyond these.",
    };
  },
});
