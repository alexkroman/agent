import { countWords } from "@alexkroman1/aai/utils";
import { roadsideCall } from "../call.ts";
import { disclosureFor, roadsideSlot } from "../shared.ts";

/**
 * The words the caller has to hear, handed over verbatim. The disclosure
 * VARIES with the plan and an `instruction` is a fixed string — so the state
 * says "read what this gives you", and the words arrive as a tool result the
 * model is asked to repeat rather than guidance it is asked to act on.
 *
 * **This is where `interruption: "off"` does its work**, and it is why this
 * tool sends nothing: the knobs apply per STEP, so the reply that reads these
 * sentences out is generated inside `onCall.disclosure`, with barge-in off.
 * Advancing is `acknowledge_disclosure`'s job, a turn later. The one write is
 * the timestamp that tool refuses without.
 */
export default roadsideSlot.updateTool({
  description:
    "Get the exact service-fee disclosure for this caller's plan. Read the text back word for " +
    "word — do not shorten it, paraphrase it, or fold it into another sentence.",
  dialog: roadsideCall,
  when: "onCall.disclosure",
  execute(_args, state, ctx) {
    const words = disclosureFor(state.coverage);
    state.disclosureReadAt = ctx.now();
    // The count is what lets a spec assert that what was spoken is the whole
    // thing rather than the first clause of it.
    return { readThisVerbatim: words, wordCount: countWords(words) };
  },
});
