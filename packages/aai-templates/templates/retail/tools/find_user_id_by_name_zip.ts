import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { authenticateAs } from "../authenticate.ts";
import { retailSlot, retailTool } from "../store.ts";

export default retailTool({
  name: "find_user_id_by_name_zip",
  description:
    "Find a customer's user id by first name, last name and zip code. Use this only when the " +
    "caller cannot remember the email address on the account.",
  inputSchema: z.object({
    first_name: z.string().max(100).describe("First name, e.g. 'John'"),
    last_name: z.string().max(100).describe("Last name, e.g. 'Doe'"),
    zip: z.string().max(20).describe("Zip code, e.g. '12345'"),
  }),
  requiresAuth: false,
  // `execute` before `summary`: see find_user_id_by_email.ts for why the order
  // is load-bearing for the generic `result` type in `summary`.
  execute: (args, ctx) => {
    const state = retailSlot.get(ctx);
    const first = args.first_name.trim().toLowerCase();
    const last = args.last_name.trim().toLowerCase();
    const zip = args.zip.replace(/\D/g, "");
    const match = Object.values(state.store.users).find(
      (user) =>
        user.name.first_name.toLowerCase() === first &&
        user.name.last_name.toLowerCase() === last &&
        user.address.zip === zip,
    );
    if (!match) {
      return {
        error: `No customer found for ${args.first_name} ${args.last_name} at zip ${args.zip}.`,
      };
    }
    return authenticateAs(state, match);
  },
  summary: (_args, result) =>
    isToolFailure(result) ? "lookup failed" : `identified ${result.user_id}`,
});
