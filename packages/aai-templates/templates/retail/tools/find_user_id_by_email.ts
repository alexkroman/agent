import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { authenticateAs } from "../authenticate.ts";
import { BEFORE_TRANSFER, retailTool } from "../store.ts";

export default retailTool({
  name: "find_user_id_by_email",
  description:
    "Find a customer's user id by their email address. This is how you authenticate the caller — " +
    "do it before anything else, even if they volunteer their user id. Prefer this over " +
    "find_user_id_by_name_zip unless they cannot remember the email.",
  inputSchema: z.object({
    email: z.string().max(200).describe("The customer's email, e.g. 'something@example.com'"),
  }),
  // Legal in `serving` too: a caller repeating their email must not hit an
  // error, and `authenticateAs` is what refuses a switch to a DIFFERENT
  // customer. The `IDENTIFIED` event is not sent on that refusal — a flow tool
  // sends nothing when its body answers a `ToolFailure`.
  when: BEFORE_TRANSFER,
  send: { type: "IDENTIFIED" },
  execute: (args, state) => {
    const target = args.email.trim().toLowerCase();
    const match = Object.values(state.store.users).find(
      (user) => user.email.toLowerCase() === target,
    );
    if (!match) {
      return { error: `No customer found with email ${args.email}.` };
    }
    return authenticateAs(state, match);
  },
  summary: (_args, result) =>
    isToolFailure(result) ? "lookup failed" : `identified ${result.user_id}`,
});
