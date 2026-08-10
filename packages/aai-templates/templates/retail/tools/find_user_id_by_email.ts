import { z } from "zod";
import { authenticateAs } from "../authenticate.ts";
import { retailSlot, retailTool } from "../store.ts";

export const findUserIdByEmail = retailTool({
  name: "find_user_id_by_email",
  description:
    "Find a customer's user id by their email address. This is how you authenticate the caller — " +
    "do it before anything else, even if they volunteer their user id. Prefer this over " +
    "find_user_id_by_name_zip unless they cannot remember the email.",
  inputSchema: z.object({
    email: z.string().max(200).describe("The customer's email, e.g. 'something@example.com'"),
  }),
  requiresAuth: false,
  // `execute` must come before `summary` in this object literal: TS infers the
  // wrapper's generic `R` from `execute`'s return type, and processes object
  // literal properties in source order — with `summary` first, `result` in its
  // signature can't be inferred and silently falls back to `unknown`.
  execute: (args, ctx) => {
    const state = retailSlot.get(ctx);
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
    "error" in result ? "lookup failed" : `identified ${result.user_id}`,
});
