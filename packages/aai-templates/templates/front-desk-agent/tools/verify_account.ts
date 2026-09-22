import type { HandoffResult } from "@alexkroman1/aai";
import { toolFailure } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { desk, deskSlot, findAccount } from "../shared.ts";

/**
 * Verify the caller, and hand them to the desk they asked for in the SAME call.
 *
 * This is the author-routed handoff: the tool IS the decision. Once the caller
 * is verified there is nothing left for triage to decide, so making the model
 * call `handoff` as a second step would be a round trip spent re-deriving what
 * this body already knows. `desk.handoff` writes the persona slot, and the
 * returned `instruction` tells the model who it is from the next step on — the
 * pipeline re-reads the prompt and the tool set per step, so the same turn
 * continues as billing or support.
 *
 * A file under `tools/` rather than a tool on the `triage` persona, because
 * every desk needs it: support verifies a caller who went straight there.
 */
export default deskSlot.updateTool({
  description:
    "Verify the caller by account number and zip code, then hand them to the desk they need. " +
    "Call this ONCE the caller has given both; it moves them to billing or support itself.",
  inputSchema: z.object({
    accountNumber: z.string().describe("Digits only, as the caller said them."),
    zip: z.string().describe("Five digits."),
    needs: z.enum(["billing", "support"]).describe("Which desk the caller's question is for."),
  }),
  execute({ accountNumber, zip, needs }, draft, ctx): HandoffResult | { error: string } {
    const account = findAccount(accountNumber.replaceAll(/\D/g, ""), zip.trim());
    if (!account) {
      return toolFailure(
        "No account matches that number and zip code. Ask the caller to repeat them, one at a time.",
      );
    }
    draft.verified = { number: account.number, name: account.name };
    return desk.handoff(ctx, needs, {
      note: `${account.name} is verified (account ${account.number}) and asked for ${needs}.`,
    });
  },
});
