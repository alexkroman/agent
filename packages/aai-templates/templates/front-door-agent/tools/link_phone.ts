import { hashCode, requireSessionClient, spokenDigits, tool, toolFailure } from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { linkSlot, MAX_LINK_ATTEMPTS } from "../shared.ts";
import pair from "../workflows/pair.ts";

// "Link my phone, the code is 4 8 1 9 0 2." The phone asked for that code (POST
// /api/pair), and a run is waiting under the code's hash. This hashes what the door
// heard (spokenDigits drops everything but the digits, so "4819-02" and "four eight one
// nine oh two" read the same once STT has written them as digits), and if a phone is
// waiting under it, signals the run with this door's id. A wrong code counts against the
// conversation's cap, and the slot window makes the count and the check one step.

export default tool({
  effect: "write",
  description:
    "Link the owner's phone to this door. Use it when someone says they want to link or " +
    "pair their phone and reads out the six-digit code their phone shows.",
  ui: { icon: "\u{1F4F1}", label: "Linking a phone" },
  inputSchema: z.object({
    code: z.string().describe("The digits they read out, exactly as heard"),
  }),
  async execute({ code }, ctx) {
    const doorId = requireSessionClient(ctx, "This door has no id to link a phone to.");
    if (isToolFailure(doorId)) return doorId;
    const key = await linkSlot.transact(ctx, {
      require: (link) =>
        link.attempts >= MAX_LINK_ATTEMPTS
          ? toolFailure("Too many wrong codes. Ask them to start again from their phone.")
          : undefined,
      prepare: async () => {
        const hash = await hashCode(spokenDigits(code));
        return (await ctx.workflows.live(pair, hash)) === undefined ? undefined : hash;
      },
      commit: (link, hash) => {
        if (hash === undefined) link.attempts += 1;
        return hash;
      },
    });
    if (isToolFailure(key)) return key;
    if (key === undefined) {
      return toolFailure(
        "That code doesn't match a phone waiting to link. Ask them to read it again.",
      );
    }
    await ctx.workflows.signalRun(pair, key, "linked", { doorId });
    return { linked: true };
  },
});
