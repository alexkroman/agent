import { agent } from "@alexkroman1/aai";

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
 * Compare `web-researcher`, which gives the search builtins to the agent
 * itself: that is the right shape for one lookup, and the wrong one the moment
 * a question has four sides.
 */
export default agent({
  name: "Briefing Desk",
  greeting:
    "Briefing desk. Tell me a subject and I'll put a few researchers on it — " +
    "try something like, what's going on with home battery prices.",
});
