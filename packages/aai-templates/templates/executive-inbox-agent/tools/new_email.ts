import { z } from "zod";
import { EXECUTIVE } from "../inbox.ts";
import { rewriteDraft } from "../nodes.ts";
import { openThread, propose, requireOpenEmail } from "../review.ts";
import { assistantSlot, DRAFTING, reviewFlow } from "../shared.ts";

/**
 * Their `NewEmailDraft` — a fresh thread, such as the introduction the open
 * email asked for. Declared in their drafting tool list; their `take_action`
 * has no arm for it and routes it to `bad_tool_name`, so this is the arm the
 * prompt describes — rewritten and staged like a reply, sent only by `accept`.
 */
export default assistantSlot.updateTool({
  description:
    `Start a NEW email thread from ${EXECUTIVE.name} — for an introduction they agreed to make, ` +
    "or a note the open email calls for to someone not on it. Full text, their voice. Staged " +
    "for read-back, not sent.",
  ui: { icon: "\u{1F4E7}", label: "Drafting new email" },
  dialog: reviewFlow,
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
  require: requireOpenEmail,
  prepare: (args, state, ctx) =>
    rewriteDraft(
      ctx.generate,
      EXECUTIVE,
      state.memory.rewriteInstructions,
      args.content,
      openThread(state),
    ),
  execute: (args, state, tone) =>
    propose(state, {
      kind: "new_email",
      content: tone.rewrittenContent,
      recipients: [...args.recipients],
      toneLogic: tone.toneLogic,
    }),
});
