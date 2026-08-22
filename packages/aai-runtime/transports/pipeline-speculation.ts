// Copyright 2026 the AAI authors. MIT license.
/**
 * PREEMPTIVE GENERATION — the policy and the store.
 *
 * A speculation is a `streamText` call started from a high-confidence STT
 * INTERIM (`SttTurnMeta.endOfTurnConfidence` at or above
 * {@link PREEMPTIVE_CONFIDENCE_THRESHOLD}) and drained into memory. When the
 * committed final arrives, the real turn asks for it BY TEXT; on a match it
 * adopts the same live stream, so the head start is real generation rather than
 * a cache lookup. On any mismatch the stream is aborted and the turn proceeds
 * exactly as it does today. OFF by default — see `AgentDef.preemptiveGeneration`
 * for what is and is not known about it, and for the tool-call distribution
 * that BOUNDS its reach.
 *
 * **What a speculation never does**, and why each is structural rather than a
 * flag:
 * - It never SPEAKS. The tape has no `sendTtsText` in scope — see
 *   `pipeline-speculative-stream.ts`.
 * - It never EXECUTES a tool. Its tool set is built by `toDeclaredTools`, which
 *   omits the `execute` property entirely, so the SDK cannot continue past a
 *   tool call. A speculation that reaches one is discarded WHOLE, preamble
 *   included.
 * - It never occupies a turn. No `turns.begin`, no chained turn, no history
 *   write, no client callback — so `turns.inFlight()` stays false and every
 *   barge-in gate behaves exactly as it does with the flag off. Deliberately
 *   outside the turn chain, because that chain exists to serialize
 *   SIDE-EFFECTING turns and queueing a speculation would make it block the
 *   very turn it exists to accelerate.
 *
 * **Why it may never COMMIT, only accelerate.** Acting on an incomplete
 * utterance is a measured failure mode in this repo, from the other direction:
 * see the endpointing record on `DEFAULT_MIN_TURN_SILENCE_MS` (do not restate
 * the numbers here — read them there), where shortening the window so the agent
 * answered fragments cost 5.7x in tau2-bench retail reward, with tool-argument
 * corruption nearly doubling. Preemption shares the cause and differs only in
 * mechanism, and the rule that keeps it out of that class is that a final which
 * merely EXTENDS the partial is a mismatch like any other. The speculation is
 * discarded; nothing it produced is ever spoken or recorded.
 *
 * **Surviving the confidence sawtooth.** The signal is not a ramp — the trace
 * lives on `SttTurnMeta.endOfTurnConfidence` in `sdk/providers.ts` — so "fire
 * above the threshold" is not a policy. Three rules are:
 * 1. a partial whose NORMALIZED TEXT differs from the live speculation's prompt
 *    aborts it immediately, so a mid-identifier peak dies on the next digit
 *    rather than being billed in full;
 * 2. an identical text at rising confidence never re-fires (the recorded
 *    terminal `0.95 → 1` re-emission);
 * 3. at most {@link MAX_PREEMPTIVE_SPECULATIONS_PER_UTTERANCE} per utterance.
 */

import type { ToolChoice } from "@alexkroman1/aai";
import {
  MAX_PREEMPTIVE_SPECULATIONS_PER_UTTERANCE,
  PREEMPTIVE_CONFIDENCE_THRESHOLD,
} from "@alexkroman1/aai/host-internal";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { LanguageModel } from "ai";
import type { Logger } from "../runtime-config.ts";
import { toDeclaredTools } from "../to-vercel-tools.ts";
import { createToolCallRepair } from "../tool-call-repair.ts";
import type { PipelineHistory } from "./pipeline-history.ts";
import type { AdoptedLlmStream } from "./pipeline-llm-stream.ts";
import { type SpeculativeStream, startSpeculativeStream } from "./pipeline-speculative-stream.ts";
import { normalizeUtterance } from "./pipeline-text.ts";

/**
 * Why a speculation was thrown away. Logged rather than counted, because the
 * shape of the distribution is what would set the threshold: `mismatch`
 * dominating means the threshold is too low, `superseded` dominating means the
 * caller is still talking when it fires.
 */
export type SpeculationDiscardReason =
  | "superseded" /* a later partial said something else */
  | "mismatch" /* the committed final was not the speculated text */
  | "poisoned" /* the stream hit a tool call or an error */
  | "history-moved" /* the conversation changed underneath it */
  | "utterance-idle" /* the utterance ended without ever committing */
  | "turn-started" /* some other turn took the floor */
  | "reset" /* reset / stop / cancelReply */;

/** The transport-facing surface of preemptive generation. */
export interface SpeculationController {
  /** An interim transcript arrived, with the provider's end-of-turn confidence. */
  onPartial(text: string, eotConfidence?: number): void;
  /** A final committed. Aborts a speculation this text cannot possibly match. */
  onFinal(text: string): void;
  /** The utterance went quiet with no final — nothing will ever adopt this. */
  onUtteranceIdle(): void;
  /**
   * Claim the speculation for `userText`, or `null`.
   *
   * Takes it either way: a speculation that does not match is discarded here
   * rather than left to be adopted by a later, unrelated turn.
   *
   * Returns the stream rather than an {@link AdoptedLlmStream} because the turn
   * does not have its abort signal yet at the moment it claims — `runReply`
   * mints that one line later, and `adopt(signal)` is what re-parents the
   * running request onto it.
   */
  take(userText: string): SpeculativeStream | null;
  /** Throw away whatever is held (if anything), aborting its request. */
  discard(reason: SpeculationDiscardReason): void;
}

/** Dependencies of {@link createSpeculationController}. */
export interface SpeculationControllerDeps {
  /**
   * The author's `preemptiveGeneration`. False ⇒ every method is inert and no
   * speculative request is ever assembled, which is the property the "flag
   * defaults off" spec asserts.
   */
  enabled: boolean;
  /**
   * May a speculation start right now? The transport passes "no turn in flight
   * and no audio still playing". Speculating while the agent speaks is excluded
   * to keep abort ordering and history simple — revisit only with a
   * measurement.
   */
  isIdle(): boolean;
  /** The history revision a speculation is launched against — see PipelineHistory.revision. */
  historyRevision(): number;
  /** Is `revision` still the current one? */
  historyIsCurrent(revision: number): boolean;
  /** Launch the request. Injected so this module never imports `streamText`. */
  start(userText: string): SpeculativeStream;
  log: Logger;
  sid: string;
}

/** Create the {@link SpeculationController}. */
export function createSpeculationController(
  deps: SpeculationControllerDeps,
): SpeculationController {
  /** The live speculation, its match key, and the history it was built on. */
  let held: { stream: SpeculativeStream; key: string; revision: number } | null = null;
  /** Speculations started for the CURRENT utterance; reset when one ends. */
  let spentThisUtterance = 0;

  function discard(reason: SpeculationDiscardReason): void {
    if (!held) return;
    const { stream } = held;
    held = null;
    stream.abort();
    deps.log.debug("Pipeline speculation discarded", { sid: deps.sid, reason });
  }

  /** An utterance is over (committed or abandoned): restore the budget. */
  function endUtterance(): void {
    spentThisUtterance = 0;
  }

  /**
   * The three sawtooth rules plus the idle gate, hoisted out of `onPartial` to
   * keep that handler under biome's cognitive-complexity cap. Rule 2 (never
   * re-fire on identical text at rising confidence) is the `held` check, and it
   * comes FIRST so it holds however the confidence moves.
   */
  function mayFire(eotConfidence: number | undefined): boolean {
    if (held) return false;
    if ((eotConfidence ?? 0) < PREEMPTIVE_CONFIDENCE_THRESHOLD) return false;
    // Rule 3: bounded per utterance, whatever the sawtooth does.
    if (spentThisUtterance >= MAX_PREEMPTIVE_SPECULATIONS_PER_UTTERANCE) return false;
    // Speculating over a live reply is out of scope (see `isIdle`).
    return deps.isIdle();
  }

  return {
    onPartial(text: string, eotConfidence?: number): void {
      if (!deps.enabled) return;
      const key = normalizeUtterance(text);
      if (key.length === 0) return;
      // Rule 1: the caller revised what they said. Whatever is running was
      // started from a prefix that is no longer the utterance, so it can never
      // be adopted — kill it now rather than paying for the whole generation.
      if (held && held.key !== key) discard("superseded");
      if (!mayFire(eotConfidence)) return;
      spentThisUtterance += 1;
      held = { stream: deps.start(text), key, revision: deps.historyRevision() };
      deps.log.debug("Pipeline speculation started", {
        sid: deps.sid,
        eot: eotConfidence,
        spent: spentThisUtterance,
      });
    },

    onFinal(text: string): void {
      if (!deps.enabled) return;
      // Called before the turn is committed, so a doomed speculation is aborted
      // at the earliest possible instant rather than when the turn chain drains
      // — the request is billed for as long as it runs.
      if (held && held.key !== normalizeUtterance(text)) discard("mismatch");
    },

    onUtteranceIdle(): void {
      if (!deps.enabled) return;
      // The transcript stream went quiet with no final. Nothing will commit
      // this text, so nothing can adopt it. This is also what keeps
      // false-interruption recovery from ever resuming a speculation: the same
      // watchdog edge fires both.
      discard("utterance-idle");
      endUtterance();
    },

    take(userText: string): SpeculativeStream | null {
      if (!deps.enabled) return null;
      const current = held;
      // Taken unconditionally: a speculation left standing here would be
      // adopted by some later turn that never spoke the words it was built on.
      held = null;
      endUtterance();
      if (!current) return null;
      const reject = (reason: SpeculationDiscardReason): null => {
        current.stream.abort();
        deps.log.debug("Pipeline speculation discarded", { sid: deps.sid, reason });
        return null;
      };
      if (current.key !== normalizeUtterance(userText)) return reject("mismatch");
      // A tool call or an error makes the run unusable whole — the preamble
      // cannot be adopted alone without prefilling the assistant turn, which
      // changes the request shape adoption depends on.
      if (current.stream.poisoned()) return reject("poisoned");
      if (current.stream.aborted()) return reject("reset");
      // The conversation moved underneath it (a chained turn landed, a reset, a
      // reconnect seed), so the request in flight is not the request this turn
      // would assemble.
      if (!deps.historyIsCurrent(current.revision)) return reject("history-moved");
      deps.log.info("Pipeline speculation adopted", {
        sid: deps.sid,
        headStartMs: current.stream.ageMs(),
      });
      return current.stream;
    },

    discard,
  };
}

/**
 * Build the controller the transport uses, including the speculative request
 * itself.
 *
 * The request assembly lives here rather than in the transport for the reason
 * the whole feature turns on: it must be what `runTurn` would assemble for the
 * same text, and the two are only comparable while the divergence is confined
 * to one function. The differences are exactly two and both are deliberate —
 * the last user message (an interim, not a final) and the tool set (declared,
 * not executable).
 */
export function createPipelineSpeculation(deps: {
  /** The author's `preemptiveGeneration`. */
  enabled: boolean;
  /**
   * Tool selection policy. Anything other than `"auto"`/`"none"` makes the
   * whole feature inert: a required or pinned tool means every speculation ends
   * at the tool boundary and is discarded whole, so it would be pure cost.
   */
  toolChoice: ToolChoice;
  toolSchemas: readonly ToolSchema[];
  llm: LanguageModel;
  systemPrompt: string;
  temperature: number | undefined;
  maxSteps: number;
  history: PipelineHistory;
  /**
   * Session-lifetime signal. Parents every speculative request (see
   * `startSpeculativeStream`) and supplies the unreachable tool-call repair.
   */
  sessionSignal: AbortSignal;
  isIdle(): boolean;
  log: Logger;
  sid: string;
}): SpeculationController {
  // The SAME declarations with no `execute` — the structural half of "a
  // speculation never runs a tool". See toDeclaredTools.
  const tools = toDeclaredTools(deps.toolSchemas);
  return createSpeculationController({
    enabled: deps.enabled && (deps.toolChoice === "auto" || deps.toolChoice === "none"),
    isIdle: deps.isIdle,
    historyRevision: deps.history.revision.current,
    historyIsCurrent: deps.history.revision.isCurrent,
    start: (userText) =>
      startSpeculativeStream(
        {
          llm: deps.llm,
          systemPrompt: deps.systemPrompt,
          // `history.llm` is the LIVE array the turn runner is bound to, so
          // this snapshots it: the speculation must not see messages a turn
          // appends after it launched, and `history.revision` is what refuses
          // the adoption when one did.
          messages: [...deps.history.llm, { role: "user", content: userText }],
          tools,
          toolChoice: deps.toolChoice,
          temperature: deps.temperature,
          // Never reached — the tool set cannot execute, so there is no call to
          // repair — but it is part of the request, and request parity is the
          // premise adoption rests on.
          repairToolCall: createToolCallRepair(deps.llm, deps.log, () => deps.sessionSignal),
          maxSteps: deps.maxSteps,
          log: deps.log,
          sid: deps.sid,
        },
        userText,
        deps.log,
        deps.sessionSignal,
      ),
    log: deps.log,
    sid: deps.sid,
  });
}
