import { agent } from "@alexkroman1/aai";
import { roster } from "./shared.ts";

/**
 * A briefing desk you can phone: you name a subject, it puts several
 * researchers on it at once and reads you back what they found.
 *
 * **It is the worked example for `ctx.delegate` — subagents.** The desk itself
 * has NO web tools. Everything it knows comes back from a subagent run started
 * inside a tool call: `researcher` (search + page reads, six steps) for each
 * angle of a topic, `fact-checker` (search only, two steps, a cheaper model)
 * for one claim at a time. `shared.ts` declares both and argues the split.
 *
 * **What that buys, on a phone call specifically.** A researcher may read tens
 * of thousands of tokens of web pages; what crosses back into the conversation
 * is its final paragraph. So the desk stays coherent over a long call — its
 * context grows by a summary per angle rather than by everything four
 * researchers read — and the four angles run at once, so the caller waits for
 * the slowest rather than the sum. `tools/research_topic.ts` is where both of
 * those actually happen.
 *
 * **`subagents` is the OTHER way to reach one, and both are here on purpose.**
 * The two tools above name their subagent in code, because the tool IS the
 * choice: one fans a single researcher over several angles, the other reads the
 * board to work out which sentence the caller meant. The roster declared below
 * is for the case where the choice is the caller's — "what does curtailment
 * mean" wants the explainer and "who says otherwise" wants the counterpoint,
 * and nothing but the question tells them apart. It reaches the model as one
 * `delegate` tool listing both, so a third subagent is a line here rather
 * than a fourth file in `tools/` whose body is one `ctx.delegate` call.
 *
 * Compare `web-research-agent`, which gives the search builtins to the agent
 * itself: that is the right shape for one lookup, and the wrong one the moment
 * a question has four sides.
 */
export default agent({
  name: "Briefing Desk",
  // The listing line — a registry row, the studio's picker. "At once" is the
  // part worth a reader's attention: it is what the subagents below buy.
  description: "Researches a subject from several angles at once and reads back what was found",
  greeting:
    "Briefing desk. Tell me a subject and I'll put a few researchers on it — " +
    "try something like, what's going on with home battery prices.",
  subagents: roster,
});
