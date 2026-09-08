import { z } from "zod";
import { EXECUTIVE } from "../inbox.ts";
import { propose } from "../review.ts";
import { assistantSlot, DRAFTING, reviewFlow } from "../shared.ts";

/**
 * Their `Question` → `send_message`: something only the executive knows.
 *
 * On a phone the assistant could simply ask. It is a TOOL anyway, for the two
 * things their graph gets from making it one: the answer arrives through
 * `respond`, which is what runs the `background` reflection on it — the fact
 * the executive just supplied is the kind of thing memory should keep — and the
 * gate records that a question is waiting, so `accept` cannot be the answer to
 * it.
 */
export default reviewFlow.tool({
  description:
    `Ask ${EXECUTIVE.name} for a fact you need and do not have — a name, an address, a decision. ` +
    "Stages the question so their answer comes back through respond. Never for their free " +
    "time (meeting_assistant knows that).",
  when: DRAFTING,
  send: { type: "PROPOSED" },
  inputSchema: z.object({
    content: z.string().min(1).max(500).describe("The question, in one sentence"),
  }),
  execute: (args, ctx) =>
    assistantSlot.update(ctx, (state) =>
      propose(state, { kind: "question", content: args.content }),
    ),
});
