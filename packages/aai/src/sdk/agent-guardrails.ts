// Copyright 2026 the AAI authors. MIT license.
/**
 * The agent's own guardrails — the one place a declaration may STOP a turn.
 *
 * `agent({ events })` is observe-only by contract: a handler's return value is
 * ignored, and that is what keeps the event stream a log rather than a second
 * control path. So until this existed there was no interception point anywhere
 * on the main agent — `SubagentDef.guardrail` could send a delegated answer
 * back, and the agent doing the talking could not be checked at all.
 *
 * Split out of `types.ts` for the reason `agent-voice-tuning.ts` and
 * `agent-model-tuning.ts` are: a group of `AgentDef` fields sharing one rule,
 * declared where the rule can be argued at length. The rule here is the one
 * below, and it is the whole design.
 *
 * ## What a guardrail can and cannot prevent
 *
 * **Pipeline mode: a real block.** Every word the agent speaks passes through
 * one funnel on its way to the synthesizer, so an output guardrail HOLDS the
 * reply there — nothing is spoken until the reply is complete and every
 * guardrail has accepted it. A rejected reply is never synthesized: the caller
 * hears the guardrail's own sentence instead and the blocked text is kept out
 * of the conversation history, so the next turn is not built on it.
 *
 * **S2S mode: impossible, and REFUSED rather than ignored.** There the provider
 * synthesizes the audio itself and streams it to the caller; the matching text
 * reaches this runtime alongside audio the caller is already hearing. A
 * guardrail there could only report on a sentence that has been said, which is
 * not a guardrail. `assertGuardrailScope` refuses the combination at config
 * time — the same treatment `temperature` gets, and for the same reason: a
 * safety control that is accepted and quietly does nothing is worse than one
 * that was never offered.
 *
 * **Text mode: refused too, and for a structural reason rather than a physical
 * one.** `createTextAgent().stream()` hands back the AI SDK's own
 * `StreamTextResult` — deliberately, so every chat surface's existing consumer
 * works — which means this runtime owns no funnel between the model and the
 * caller and has nowhere to hold a reply while a guardrail decides. A caller
 * there already has the whole stream and can gate it itself. Refused rather
 * than ignored, on the same rule.
 *
 * ## What it does NOT do
 *
 * It does not ask the model for a better answer. {@link SubagentDef.guardrail}
 * does, and can afford to: nobody is listening to a subagent, so a full re-run
 * costs time no human is spending. The agent's own reply is different — a
 * rewrite is another whole turn while a caller sits in silence, and the honest
 * options at that point are the fallback sentence or nothing. So the verdict
 * string is SPOKEN here, where on a subagent it is a complaint the retry
 * carries. Write it as something the caller should hear.
 */

import type { AgentSessionContext } from "./agent-session-context.ts";
import type { GuardrailVerdict } from "./subagent.ts";

/**
 * A guardrail's verdict: `true` to accept, or the sentence to use instead.
 *
 * The same vocabulary {@link SubagentGuardrail} answers in, deliberately — one
 * word for one idea across the SDK. What differs is who reads the string: a
 * subagent's complaint goes back to the subagent, and an agent's goes to the
 * caller's ear.
 *
 * @public
 */
export type { GuardrailVerdict } from "./subagent.ts";

/**
 * Judge one piece of text — see {@link AgentDef.inputGuardrails} and
 * {@link AgentDef.outputGuardrails}.
 *
 * May be async: an input guardrail runs before the model request is assembled
 * and an output guardrail runs before anything is synthesized, so both have a
 * moment to await a classifier. Both are on the critical path of a live call —
 * whatever they spend, the caller waits.
 *
 * A guardrail that THROWS fails open: the throw is reported on the session's
 * error stream and the text is allowed through. A check that cannot decide has
 * not decided, and taking a call down because a moderation endpoint timed out
 * is the wrong trade for every agent that is not a moderation product. An agent
 * that wants the other trade returns a verdict from its own `catch`.
 *
 * @public
 */
export type AgentGuardrail = (
  text: string,
  ctx: AgentSessionContext,
) => GuardrailVerdict | Promise<GuardrailVerdict>;

/**
 * The two guardrail fields on {@link AgentDef} — see this module's header for
 * what each can actually prevent.
 *
 * @public
 */
export interface AgentGuardrails {
  /**
   * Check what the CALLER said, before the turn is sent to the model.
   *
   * Pipeline mode only — see this module's header. Run in order on each
   * committed user utterance; the first one to return a string wins and the model is never asked. The agent says that string
   * instead, the turn is recorded as having happened (so a caller who keeps
   * asking is not talking to an agent with amnesia), and the refused utterance
   * stays in the conversation exactly as it was said.
   *
   * ```ts
   * import { agent } from "@alexkroman1/aai";
   *
   * export default agent({
   *   name: "Support",
   *   inputGuardrails: [
   *     (text) =>
   *       /\b\d{3}-\d{2}-\d{4}\b/.test(text)
   *         ? "Please don't read out your social security number — I don't need it."
   *         : true,
   *   ],
   * });
   * ```
   *
   * It runs on what the transcriber HEARD, which is the only thing this
   * runtime has: a caller who says a forbidden thing and is misheard is not
   * caught, and one who is misheard INTO saying it is caught wrongly. Write the
   * check so both failures are survivable.
   */
  inputGuardrails?: readonly AgentGuardrail[];
  /**
   * Check what the AGENT is about to say, before any of it is spoken.
   *
   * Pipeline mode only — see this module's header for why S2S and text refuse
   * it. Run in order on the reply's full text once the model has finished and
   * before a single word reaches the synthesizer; the first one to return a
   * string wins and that sentence is spoken in place of the reply. The blocked
   * text is never synthesized and never enters the conversation history.
   *
   * ```ts
   * import { agent } from "@alexkroman1/aai";
   *
   * export default agent({
   *   name: "Pharmacy Line",
   *   outputGuardrails: [
   *     (text) =>
   *       /\b\d+\s?(mg|ml|mcg)\b/i.test(text)
   *         ? "I can't give dosage information over the phone. Please check with your pharmacist."
   *         : true,
   *   ],
   * });
   * ```
   *
   * **It costs the streaming.** A reply that must be judged whole cannot be
   * spoken as it arrives, so declaring one trades time-to-first-word for the
   * check: the caller hears nothing until the model has finished, with the
   * dead-air cover filling the gap exactly as it does during a tool chain.
   * That is the price of a block that is real, and it is why this is a field an
   * agent opts into rather than a hook every agent pays for.
   */
  outputGuardrails?: readonly AgentGuardrail[];
}

/**
 * Both {@link AgentGuardrails} fields, with the text each one judges.
 *
 * The one declaration `assertGuardrailScope` (`config-rules.ts`) derives its
 * field list from, so the mode check cannot fall behind the interface. The
 * `satisfies` is what makes that real: it makes the object TOTAL over
 * {@link AgentGuardrails}, so a third guardrail field added to the interface
 * and not to this table is a compile error here rather than a SAFETY control
 * an s2s or text agent may declare and never have honoured.
 *
 * Same mechanism, and the same lesson, as `MODEL_TUNING_FIELDS` and
 * `PIPELINE_ONLY_TUNING` — the two neighbouring gates this one was written as a
 * pair of string literals beside. The lesson is `startFailurePhrase`, which
 * slipped past the pipeline gate exactly that way; the cost of the same slip
 * here is the one thing this SDK refuses to pay silently, because a guardrail
 * that is accepted and does nothing costs precisely what it was declared to
 * prevent.
 *
 * @internal
 */
export const GUARDRAIL_FIELDS = {
  inputGuardrails: "what the caller said",
  outputGuardrails: "what the agent is about to say",
} as const satisfies Record<keyof AgentGuardrails, string>;

/** One {@link AgentGuardrails} field name. @internal */
export type GuardrailField = keyof typeof GUARDRAIL_FIELDS;

/**
 * Run a list of guardrails in order and answer the first refusal.
 *
 * One implementation for both directions, because "first refusal wins, a throw
 * fails open" is the contract rather than each direction's own loop — and a
 * caller that wrote the loop itself is a caller that can get the throw rule
 * backwards. There is ONE production caller today, `createTurnGuardrails` in
 * `aai-runtime`'s pipeline transport, which binds it once per direction; the
 * other two modes never reach it, because `assertGuardrailScope` refuses a
 * guardrail on an s2s or text agent at config time.
 *
 * `onError` is how the fail-open throw is REPORTED; a guardrail that fails
 * silently is a guardrail nobody knows has stopped working.
 *
 * @internal
 */
export async function runAgentGuardrails(
  guardrails: readonly AgentGuardrail[] | undefined,
  text: string,
  ctx: AgentSessionContext,
  onError: (err: unknown) => void,
): Promise<string | undefined> {
  if (guardrails === undefined || guardrails.length === 0) return undefined;
  for (const guardrail of guardrails) {
    let verdict: GuardrailVerdict;
    try {
      verdict = await guardrail(text, ctx);
    } catch (err: unknown) {
      onError(err);
      continue;
    }
    // `typeof === "string"` already excludes `true`, the only other arm of
    // `GuardrailVerdict`. The `""` check is deliberate and not a truthiness
    // shortcut: the empty string is what a guardrail returns when it MEANT to
    // accept and reached for the wrong falsy value, and refusing a turn into
    // silence — the caller hears nothing at all — is the one outcome worse than
    // letting the text through. So it reads as acceptance.
    if (typeof verdict === "string" && verdict !== "") return verdict;
  }
  return undefined;
}
