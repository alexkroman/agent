// Copyright 2026 the AAI authors. MIT license.
/**
 * The regex-keyed endpointing layer, wired to a session.
 *
 * `sdk/endpointing-rules.ts` owns the TABLE — the three rule kinds, first
 * match wins, the substring semantics and the caps. This module is the half
 * that has a session: it decides WHEN the table is re-read, and it pushes the
 * answer to the place that actually serves the wait.
 *
 * ## The wait is the STT's, which is why this pushes rather than holds
 *
 * Endpointing lives in the provider (`DEFAULT_MIN_TURN_SILENCE_MS`: the
 * service transcribes at the floor, asks whether the turn READS as complete,
 * and keeps the turn open if it does not). The transport learns a turn ended
 * by being handed a final, which is strictly after the decision — so a
 * host-side hold could only ever DELAY a turn the provider had already split,
 * and could not shorten one at all. AssemblyAI can be re-configured
 * mid-stream (`UpdateConfiguration.min_turn_silence`), so the override is
 * pushed to the socket and the provider keeps owning the decision.
 *
 * A provider without that verb gets one warning and an inert table
 * ({@link EndpointingPolicy}'s `apply` is absent). Silence would be worse:
 * the table is a declaration about turn-taking, and one that does nothing
 * reads as a tuning that did not help.
 *
 * ## Re-read on every partial, pushed only on a CHANGE
 *
 * Both inputs move during an utterance — the caller's in-flight transcript by
 * definition, and the agent's last message whenever a reply lands — so the
 * table is re-read on each STT partial (~5/s while someone is talking) and on
 * the final that ends an utterance. That is cheap (the patterns are compiled
 * once per rule object) and the wire frame is not, so a push happens only when
 * the resolved value differs from the one in force. The provider adapter
 * change-gates a second time for the same reason, and neither gate is
 * redundant: this one keeps the LOG honest, that one keeps a second caller
 * from re-sending.
 *
 * **The reset on a final is deliberate.** Between utterances the user side of
 * the table is `""`, so a `user` rule stops matching and the window returns to
 * the assistant-keyed answer — otherwise the 2600ms a digit-final transcript
 * bought would still be in force for the NEXT utterance, which is the sort of
 * latency nobody can explain from the logs.
 *
 * ## A mid-stream change is IMMEDIATE, so the constraint is a RACE
 *
 * AssemblyAI documents turn-detection updates as taking effect immediately,
 * without reconnecting — and the contrast in the same docs is explicit enough
 * to rely on: `language_codes` applies "from the next turn",
 * `keyterms_prompt` "immediately for subsequent audio processing", and turn
 * detection is in the immediate class. Their own worked example is this
 * module's rule 2 ("your voice agent just asked for a callback number — raise
 * `min_turn_silence` mid-stream so those pauses don't end the turn").
 *
 * So a `user`-keyed rule is not inert by construction; what bounds it is a
 * RACE. The end-of-turn check fires after `min_turn_silence` of silence, so a
 * push has to land INSIDE that window to govern the turn it was computed for.
 * Two things follow, and both are implemented rather than noted:
 *
 * - **Push from the EARLIEST partial that can match, not the latest.** The
 *   table is re-read on every partial including the first, and the push runs
 *   SYNCHRONOUSLY inside that handler — no queue, no await — so host-side
 *   latency is not a term in the race and the only delay is the frame's flight
 *   time. The `Pipeline endpointing override` line names the transition, which
 *   is what correlates it against the provider's own turn trace when a rule
 *   looks like it did not take.
 * - **The restore writes our own numbers back, and there is no `mode` to
 *   restore.** The docs' advice for a preset user is to re-send `mode`
 *   afterwards, since a raw number would leave the preset's other defaults
 *   behind. That does not apply here: this pipeline never sends `mode` at all
 *   (`DEFAULT_MIN_TURN_SILENCE_MS` records why every preset is ruled out —
 *   even `max_accuracy` is tuned for clean dictation into a mic), and both
 *   halves of the pair are always sent explicitly. So restoring
 *   `minTurnSilenceMs` restores the whole configuration. If a future agent
 *   ever does send `mode`, this restore becomes wrong and has to re-send it.
 */

import type { EndpointingRule } from "@alexkroman1/aai";
import type { SttSession } from "@alexkroman1/aai/host-internal";
import { clampEndpointingTimeout, matchEndpointingRule } from "@alexkroman1/aai/internal";
import type { SttEndpointingWindow } from "../providers/_provider-settings.ts";
import type { Logger } from "../runtime-config.ts";
import type { PipelineHistory } from "./pipeline-history.ts";

/** The session-facing half of the rule table. */
export interface EndpointingPolicy {
  /**
   * An interim transcript arrived — re-read the table against it and push any
   * change.
   */
  onUserPartial(text: string): void;
  /**
   * The utterance ended. Drops the user side of the table back to `""`, so a
   * `user` rule's window does not outlive the utterance that earned it.
   */
  onUtteranceEnded(): void;
}

/** A policy that reads no table and pushes nothing. */
const INERT: EndpointingPolicy = {
  onUserPartial: () => undefined,
  onUtteranceEnded: () => undefined,
};

export function createEndpointingPolicy(deps: {
  /** The agent's declared table; an empty one makes this inert. */
  rules: readonly EndpointingRule[];
  /** The window in force when no rule matches — the agent's own `minTurnSilenceMs`. */
  baseTimeoutMs: number;
  /** The session's `maxTurnSilenceMs`; no rule may push the floor past it. */
  maxTurnSilenceMs: number;
  /** The agent's last message, or `undefined` before it has said anything. */
  lastAgentMessage: () => string | undefined;
  /**
   * Push a window to the STT session, or `undefined` when this session's
   * provider cannot move one mid-stream.
   */
  apply: (() => ((minTurnSilenceMs: number) => void) | undefined) | undefined;
  log: Logger;
  sid: string;
}): EndpointingPolicy {
  if (deps.rules.length === 0) return INERT;

  /** The value last pushed — start at the base, which is what the socket dialled. */
  let inForce = deps.baseTimeoutMs;
  /** Warned once per session that the provider cannot honour the table. */
  let warnedUnsupported = false;

  function resolve(userTranscript: string): number {
    const hit = matchEndpointingRule(deps.rules, {
      assistantMessage: deps.lastAgentMessage(),
      userTranscript,
    });
    if (hit === undefined) return deps.baseTimeoutMs;
    return clampEndpointingTimeout(hit.timeoutMs, deps.maxTurnSilenceMs);
  }

  function push(userTranscript: string): void {
    const next = resolve(userTranscript);
    if (next === inForce) return;
    const update = deps.apply?.();
    if (update === undefined) {
      if (warnedUnsupported) return;
      warnedUnsupported = true;
      deps.log.warn(
        "This agent declares endpointingRules, and its STT provider cannot move its end-of-turn window mid-stream — the table is inert for this session. Endpointing is the provider's decision, so there is no host-side moment at which a rule could take effect; AssemblyAI is the provider that supports it today.",
        { sid: deps.sid },
      );
      return;
    }
    deps.log.info("Pipeline endpointing override", {
      sid: deps.sid,
      fromMs: inForce,
      toMs: next,
      baseMs: deps.baseTimeoutMs,
    });
    inForce = next;
    update(next);
  }

  return {
    onUserPartial: (text) => push(text),
    onUtteranceEnded: () => push(""),
  };
}

/**
 * The agent's last message, for an `"assistant"` rule.
 *
 * Read off `history.conversation` rather than latched at each of the three
 * places a reply lands (the greeting, a finished turn, an interrupted one),
 * because that view is already the one statement of what the agent has said —
 * an interrupted reply is there as the HEARD prefix, which is the right text
 * to key a rule on, and a fourth writer could not be added without a latch
 * going stale.
 */
function lastAgentMessage(history: PipelineHistory): string | undefined {
  const messages = history.conversation;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") return message.content;
  }
  return undefined;
}

/**
 * {@link createEndpointingPolicy}, wired to a session's history and STT
 * socket.
 *
 * The door the transport takes, so the two things this feature has to get
 * right are stated once rather than at a call site: the base and the ceiling
 * come from the window the STT stage really DIALLED (never the shipped
 * defaults — the clamp has to be against the ceiling in force), and an absent
 * window makes the table inert, which is exactly the set of providers with no
 * mid-stream reconfigure verb.
 */
export function createSessionEndpointing(deps: {
  rules: readonly EndpointingRule[];
  /** The pair this session's STT stage dialled, or `undefined` for a stage with none. */
  window: SttEndpointingWindow | undefined;
  history: PipelineHistory;
  /** The STT session, LAZILY — it is opened after this is built. */
  stt: () => SttSession | null | undefined;
  log: Logger;
  sid: string;
}): EndpointingPolicy {
  if (deps.window === undefined) return INERT;
  const window = deps.window;
  return createEndpointingPolicy({
    rules: deps.rules,
    baseTimeoutMs: window.minTurnSilenceMs,
    maxTurnSilenceMs: window.maxTurnSilenceMs,
    lastAgentMessage: () => lastAgentMessage(deps.history),
    apply: () => {
      const session = deps.stt();
      return session?.updateEndpointing?.bind(session);
    },
    log: deps.log,
    sid: deps.sid,
  });
}
