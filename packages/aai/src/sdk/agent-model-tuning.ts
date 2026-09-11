// Copyright 2026 the AAI authors. MIT license.
/**
 * The knobs on the model loop **this runtime runs** — and the one rule they all
 * share.
 *
 * Split out of `types.ts` when that file reached the 500-line cap, on the seam
 * {@link PipelineVoiceTuning} already established: a group of `AgentDef` fields
 * that share ONE validation rule, declared once so the rule can be derived from
 * the declaration rather than restated beside it. Here the rule is
 * **S2S refuses every one of them** — there the model runs inside the
 * provider's own service, so this runtime never assembles the request these
 * describe and a value set here would be accepted and silently dropped.
 * `assertSamplingScope` (`config-rules.ts`) derives its field list from
 * {@link MODEL_TUNING_FIELDS}, which `satisfies` a total map over this
 * interface — so a knob added here and not to that table is a compile error
 * rather than a setting an S2S agent can write and never have honoured.
 *
 * `temperature` was the first of them and carried the rule alone. It reads the
 * same way now; what changed is that the next five did not each have to
 * re-derive it.
 *
 * `twoTier` joined them last and is the first member that is not a scalar; see
 * its doc on {@link AgentModelTuning} for why S2S refusing it is structural
 * rather than merely consistent.
 *
 * These are not the VOICE-UX knobs. Those are pipeline-only because the
 * pipeline is what implements barge-in and dead air; these are pipeline-AND-TEXT
 * because both modes assemble their own model requests. A text agent has every
 * reason to set all six.
 */

import type { TwoTierConfig } from "./two-tier.ts";

/**
 * The token budget a session may spend before the runtime stops it.
 *
 * **Host-side accounting only.** The numbers come from what the provider
 * reports on each completed step (the AI SDK's `usage`), summed across the
 * session, so they exist in pipeline and text mode and NOT in S2S — there the
 * provider runs the loop and this runtime sees no token counts at all, which is
 * why an S2S agent is refused this field instead of being handed zeroes.
 *
 * ## What counts against it
 *
 * Every model request the runtime makes for this session:
 *
 * - the **conversational loop** — every step of every turn;
 * - **`ctx.generate`** from a tool body;
 * - **`ctx.delegate` / `subagent()`** — every step of the delegated run,
 *   including a guardrail's revisions.
 *
 * That list is the whole budget, and it is stated because the first release of
 * this field counted only the first line: a delegating agent spends most of
 * what it spends inside `ctx.delegate`, so a cap set on one bounded the cheap
 * half of the session while reading as though it bounded the session.
 *
 * ## What does NOT count against it
 *
 * - **A durable WORKFLOW step.** `ctx.workflows.start(…)` returns a run that
 *   outlives this session — it is resumed by the engine's own timers, possibly
 *   in another process, and a REPLAYED step reads its journaled result without
 *   calling a model at all — so a step's tokens are not part of what a SESSION
 *   spent and are not bounded here. An agent whose real cost is in its
 *   workflows needs a run-scoped budget, which this is not.
 * - **A tool executing behind the platform relay**, whose own model calls are
 *   metered by the runtime running it rather than by this one. Built-in tools,
 *   which run host-side, do count.
 * - **S2S**, which reports nothing and is refused this field outright.
 *
 * There is no cost limit here on purpose. A price is a per-model, per-region,
 * per-contract number this package does not carry and could only guess at, and
 * a budget that silently guesses wrong is worse than one stated in the unit the
 * provider actually reports.
 *
 * @public
 */
export interface UsageLimits {
  /**
   * Stop the session once this many total tokens (input + output, every step of
   * every turn) have been spent.
   *
   * Checked BEFORE each model request rather than mid-stream, and before EVERY
   * one of the three above — so the request that crosses the line finishes and
   * the NEXT one is refused, wherever it was about to be made. A cap enforced
   * mid-sentence would cut the agent off in the middle of speech, and the
   * caller would hear a dropped call rather than a limit; the overrun is
   * therefore one request rather than one turn, which matters for a tool that
   * fans out to several subagents at once.
   *
   * Reaching it ends the session at its next turn with a fatal `error.reported`
   * frame — a browser client releases the microphone and hangs up. In between,
   * a `ctx.generate` or `ctx.delegate` that asks for more is refused with the
   * same sentence, which the calling tool may catch and answer around. An agent
   * that wants a softer landing watches `usage.updated` through
   * `agent({ events })` and says something before the cap arrives.
   */
  totalTokens?: number;
}

/**
 * Sampling and budget knobs for the agent's OWN model calls — the conversational
 * loop, in pipeline and text modes. Every field here is refused in S2S mode;
 * see this module's header.
 *
 * @public
 */
export interface AgentModelTuning {
  /**
   * Sampling temperature.
   *
   * Omitted by default, so the model's own default applies; some models (Claude
   * 5 among them) ignore it and warn, so set it only for a temperature-capable
   * one. A booking desk and a game master want different values, and until this
   * existed neither could say so: `ctx.generate` and `subagent()` both took a
   * temperature while the main loop — the one that does almost all the talking
   * — took no sampling parameter at all.
   */
  temperature?: number;
  /**
   * Cap on generated tokens per step, passed straight through to the provider.
   *
   * The same field {@link SubagentDef.maxOutputTokens} and
   * {@link GenerateOptions.maxOutputTokens} already had, on the loop that does
   * the talking. Per STEP, not per turn: a reply that calls three tools has
   * four generations in it, and the cap bounds each.
   *
   * On a voice agent it is a bluntness knob rather than a cost one — a model
   * that runs long is a model the caller is waiting through — and a value low
   * enough to truncate mid-sentence will truncate mid-sentence, because the
   * provider stops emitting rather than wrapping up.
   */
  maxOutputTokens?: number;
  /**
   * How many times a FAILED provider call is retried before the turn is given
   * up on.
   *
   * @defaultValue the AI SDK's own (2 retries, exponential backoff)
   *
   * **Not {@link SubagentDef.maxRetries}, which is a different budget with the
   * same name.** That one counts how many times a subagent's `guardrail` may
   * send an ANSWER back — a re-run of a run that succeeded. This one counts
   * transport-level retries of a request that never produced an answer at all
   * (a 429, a 502, a socket reset). They compose: a subagent revision is one
   * more request, and each request still gets its own retries.
   *
   * `0` is the value to reach for on a live call, and the reason is the clock:
   * the default backoff can spend several seconds before the turn is declared
   * failed, and the caller hears every one of them as silence. An agent whose
   * `errorPhrase` should arrive promptly sets this to `0` and lets the recovery
   * line do the work.
   */
  maxRetries?: number;
  /**
   * Put `toolChoice` back to `"auto"` after the FIRST step of a reply.
   *
   * @defaultValue `true`
   *
   * Only ever observable alongside a `toolChoice` that DEMANDS a call
   * (`"required"`, or a named tool). Left on every step, such a policy is
   * re-applied to each one — so the model is obliged to call a tool again after
   * it already has, and again after that, until the whole `maxSteps` budget is
   * spent and `forceFinalAnswer` rescues the turn on the reserved step.
   * The turn still answers (it is bounded, not a loop), but it answers after
   * `maxSteps` round trips it had no use for, and the caller waits through all
   * of them.
   *
   * What `toolChoice: "required"` almost always means is "start by calling
   * something", which is exactly one step. So the reset is ON by default, the
   * same default OpenAI's Agents SDK ships (`reset_tool_choice`), and
   * `resetToolChoice: false` is how an agent that really does want a tool call
   * on every step says so.
   *
   * **It changes nothing for an agent that sets no `toolChoice`**, or one that
   * sets `"auto"` or `"none"`: there is no demand to reset, and the preparer
   * contributes no keys at all.
   */
  resetToolChoice?: boolean;
  /**
   * Bound what one session may spend — see {@link UsageLimits}.
   *
   * @defaultValue unset — no cap. Usage is still MEASURED either way; whether it
   * is also reported on the session event stream depends on whether anything
   * reads it. Declaring a limit turns `usage.updated` on, and so does an
   * `agent({ events })` handler for `usage.updated` or `"*"` — an unobserved
   * session emits nothing rather than spending a durable event per model step.
   */
  usageLimits?: UsageLimits;
  /**
   * Put a SECOND model behind the first — see {@link TwoTierConfig}.
   *
   * @defaultValue unset — one model, no gate, no digest, no extra request.
   *
   * It belongs to this group rather than to {@link PipelineVoiceTuning}
   * because it shares this group's rule exactly and not the other one's: the
   * gate interposes on the TOOL LOOP this runtime runs, so pipeline and text
   * mode both honour it and S2S structurally cannot — there the provider owns
   * the loop, calls the tool itself, and there is no moment between the
   * proposal and the mutation for a second model to stand in.
   */
  twoTier?: TwoTierConfig;
}

/**
 * Every {@link AgentModelTuning} field, with the shape a config-layer check can
 * test it by.
 *
 * The `satisfies` is what makes it TOTAL: a field added to the interface and
 * not to this table fails to compile here, rather than becoming a knob an S2S
 * agent may set and never have honoured. Same mechanism, and the same lesson,
 * as `PIPELINE_ONLY_TUNING` in `config-rules.ts` — which acquired it after
 * `startFailurePhrase` slipped through.
 *
 * @internal
 */
export const MODEL_TUNING_FIELDS = {
  temperature: "sampling temperature",
  maxOutputTokens: "a per-step output cap",
  maxRetries: "a provider-retry budget",
  resetToolChoice: "a per-step tool-choice policy",
  usageLimits: "a token budget",
  twoTier: "a second model tier",
} as const satisfies Record<keyof AgentModelTuning, string>;

/** One {@link AgentModelTuning} field name. @internal */
export type ModelTuningField = keyof typeof MODEL_TUNING_FIELDS;
