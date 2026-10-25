import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { EXECUTIVE } from "../inbox.ts";
import { rewriteDraft } from "../nodes.ts";
import { openThread, propose, requireOpenEmail } from "../review.ts";
import { assistantSlot, DRAFTING, reviewFlow } from "../shared.ts";

/**
 * Their `ResponseEmailDraft`, followed by their `rewrite` node.
 *
 * The ARGUMENTS are the draft, exactly as their drafting model's tool call
 * carries it. Then the rewriter passes over it with the tone memory — the same
 * facts, in the executive's voice — and the result is STAGED, never sent:
 * `accept` is the only thing that sends. Their graph's `rewrite → send_email_draft
 * → human_node` is this one tool call plus the read-back it asks for.
 *
 * A placeholder is refused rather than staged. Their prompt says "do not,
 * under any circumstances, draft an email with placeholders or you will get
 * fired"; a check is cheaper than a threat, and `ask_question` is the way out.
 */
const PLACEHOLDER = /\[[^\]]{1,40}\]/;

export default assistantSlot.updateTool({
  description:
    `Draft ${EXECUTIVE.name}'s reply to the open email — the full text, in their voice, as ` +
    "email prose rather than speech. It is NOT sent: it is rewritten in their tone, then " +
    "staged for you to read back. Never a placeholder; use ask_question for anything you lack.",
  ui: { icon: "\u{270D}", label: "Drafting reply" },
  dialog: reviewFlow,
  when: DRAFTING,
  send: { type: "PROPOSED" },
  inputSchema: z.object({
    content: z.string().min(1).max(4000).describe("The complete reply"),
    newRecipients: z
      .array(z.string().max(120))
      .max(5)
      .optional()
      .describe(
        `Addresses to ADD to the thread — only ones ${EXECUTIVE.name} asked for and you know`,
      ),
  }),
  require: requireOpenEmail,
  prepare: (args, state, ctx) => {
    if (PLACEHOLDER.test(args.content)) {
      return toolFailure(
        "The draft contains a placeholder in square brackets. Never draft with one — " +
          `call ask_question to get the real detail from ${EXECUTIVE.name}, then draft again.`,
      );
    }
    return rewriteDraft(
      ctx.generate,
      EXECUTIVE,
      state.memory.rewriteInstructions,
      args.content,
      openThread(state),
    );
  },
  execute: (args, state, tone) =>
    propose(state, {
      kind: "reply",
      content: tone.rewrittenContent,
      newRecipients: [...(args.newRecipients ?? [])],
      toneLogic: tone.toneLogic,
    }),
});
