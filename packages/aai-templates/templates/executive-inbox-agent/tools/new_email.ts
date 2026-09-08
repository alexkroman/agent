import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { EXECUTIVE } from "../inbox.ts";
import { rewriteDraft } from "../nodes.ts";
import { threadText } from "../prompts.ts";
import { propose } from "../review.ts";
import { assistantSlot, DRAFTING, openEmail, reviewFlow } from "../shared.ts";

/**
 * Their `NewEmailDraft` — a fresh thread, such as the introduction the open
 * email asked for. Declared in their drafting tool list; their `take_action`
 * has no arm for it and routes it to `bad_tool_name`, so this is the arm the
 * prompt describes — rewritten and staged like a reply, sent only by `accept`.
 */
export default reviewFlow.tool({
  description:
    `Start a NEW email thread from ${EXECUTIVE.name} — for an introduction they agreed to make, ` +
    "or a note the open email calls for to someone not on it. Full text, their voice. Staged " +
    "for read-back, not sent.",
  when: DRAFTING,
  send: { type: "PROPOSED" },
  inputSchema: z.object({
    recipients: z
      .array(z.string().max(120))
      .min(1)
      .max(5)
      .describe("Who it goes to — real addresses you have, never invented"),
    content: z.string().min(1).max(4000).describe("The complete email"),
  }),
  async execute(args, ctx) {
    const state = assistantSlot.get(ctx);
    const email = openEmail(state);
    if (!email) return toolFailure("No email is open — call open_email first.");
    const tone = await rewriteDraft(
      ctx.generate,
      EXECUTIVE,
      state.memory.rewriteInstructions,
      args.content,
      threadText(email),
    );
    return assistantSlot.update(ctx, (draft) =>
      propose(draft, {
        kind: "new_email",
        content: tone.rewrittenContent,
        recipients: [...args.recipients],
        toneLogic: tone.toneLogic,
      }),
    );
  },
});
