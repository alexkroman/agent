import { type AgentGuardrail, agent } from "@alexkroman1/aai";

/**
 * The check itself, named and typed rather than written inline.
 *
 * A guardrail is the one declaration in an `agent()` that can stop the agent
 * saying something, so it is worth reading on its own — and `AgentGuardrail`
 * is what types the pair it is handed (the text, and the session's context).
 */
const refuseDoses: AgentGuardrail = (text) =>
  /\b\d+(?:\.\d+)?\s?(?:mg|mcg|ml|g|iu|units?)\b/i.test(text)
    ? "I can't give dosing information — the amount to take depends on things I don't know about you. Please check the label or ask your pharmacist, and I'm happy to help with side effects or interactions."
    : true;

export default agent({
  name: "Dr. Sage",
  // Read by whoever is looking at a LIST of agents — a registry page, the
  // studio's picker — and never by the model. The model's brief is
  // `system-prompt.md`.
  description: "Answers medication questions from openFDA labels, and never gives dosing advice",
  greeting:
    "Hey, I'm Dr. Sage. Try asking me something like, what are the side effects of ibuprofen, can I take aspirin and warfarin together, or calculate my BMI. Just remember, I'm not a real doctor, so always check with your healthcare provider.",
  // Three builtins, and `fetch_json` is the one worth explaining: `fda.ts`
  // already reaches openFDA's LABEL endpoint in tool code, and a label is the
  // manufacturer's text. What the two tools cannot answer is what people
  // actually REPORT, which lives in a different dataset (`/drug/event.json`)
  // and is a counting query rather than a lookup — so it is the model's to
  // compose, not a fixed tool's. `system-prompt.md` holds the endpoint and the
  // caveat that a report count is not an incidence rate.
  builtinTools: ["web_search", "run_code", "fetch_json"],

  /**
   * The one rule in this agent's brief that must not depend on the model
   * following it.
   *
   * `system-prompt.md` already says not to give a dose. A prompt is a request,
   * and this agent reads out drug labels — every one of which contains dosing
   * text the model is one summarization away from repeating. An output
   * guardrail is the only place the sentence can be stopped, because it is the
   * only thing that runs between the model finishing and the synthesizer
   * starting (see `AgentGuardrails` — in S2S mode there is no such point, and
   * declaring one there is refused rather than ignored).
   *
   * Two properties are worth copying into your own:
   *
   * - **The verdict is what the caller HEARS**, not a complaint sent back to
   *   the model. There is no rewrite: a second full turn is time a caller
   *   spends in silence, so the honest options are the fallback sentence or
   *   nothing.
   * - **It costs the streaming.** A reply that must be judged whole cannot be
   *   spoken as it arrives, so this agent's answers begin when the model
   *   finishes rather than as it types. That is the price of a block that is
   *   real, and it is why the field is opt-in.
   *
   * The pattern deliberately does not try to be a dose PARSER. It matches a
   * number next to a dose unit, which over-blocks (a label quote that mentions
   * "200 mg tablets" is refused too) — and over-blocking is the safe direction
   * for this agent: the caller is told to ask a pharmacist, which is the answer
   * the brief wanted anyway.
   */
  outputGuardrails: [refuseDoses],
});
