import { countWords } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { roadsideCall } from "../call.ts";
import { disclosureFor, roadsideSlot } from "../shared.ts";

/**
 * The words the caller has to hear, handed over verbatim.
 *
 * A READ, and the only tool in this template that changes nothing. It exists
 * because the disclosure VARIES with the plan and an `instruction` is a fixed
 * string — so the state can say "read what this gives you", and the words
 * themselves arrive as a tool result the model is being asked to repeat rather
 * than as guidance it is being asked to act on.
 *
 * **This is where `bargeIn: "off"` does its work**, and the ordering is the
 * reason the knob is declared on the state rather than passed to a tool. The
 * knobs are applied per STEP: the step that runs after this tool returns is
 * still inside `onCall.disclosure`, so the reply that reads these sentences out
 * is generated — and spoken — with barge-in off. Had this tool moved the call
 * on to `onCall.dispatching`, the very sentence the disclosure exists for would
 * have been spoken under the NEXT state's knobs and been interruptible after
 * all. Advancing is `acknowledge_disclosure`'s job, a turn later, and that
 * split is deliberate.
 *
 * A gated READ is `dialog.tool` plus `slot.get`, and there is no third way to
 * have both: `slot.tool` hands over the frozen value but carries no `when`.
 */
export default roadsideCall.tool({
  description:
    "Get the exact service-fee disclosure for this caller's plan. Read the text back word for " +
    "word — do not shorten it, paraphrase it, or fold it into another sentence.",
  when: "onCall.disclosure",
  inputSchema: z.object({}),
  execute: (_args, ctx) => {
    const state = roadsideSlot.get(ctx);
    const words = disclosureFor(state.coverage);
    return {
      readThisVerbatim: words,
      // The count is here so a spec can assert that what was spoken is the
      // whole thing rather than the first clause of it. It is the caller's only
      // protection against a "summary" of a disclosure.
      wordCount: countWords(words),
    };
  },
});
