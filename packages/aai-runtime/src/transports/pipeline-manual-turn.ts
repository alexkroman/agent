// Copyright 2026 the AAI authors. MIT license.
/**
 * PUSH-TO-TALK — `AgentDef.turnDetection: "manual"`, applied.
 *
 * Under the default policy the transcriber ends a turn, on a pause, and every
 * committed transcript is answered. Under `"manual"` the CLIENT ends it: the
 * caller holds a button, speaks — pausing as often as they like — and lets go.
 * Three commands carry that (`user_turn_start` / `user_turn_commit` /
 * `user_turn_clear`), and this module is the state they move:
 *
 * - `closed` — no turn is open. The caller's microphone is replaced with
 *   silence before it reaches the transcriber (`isOpen` is what the audio path
 *   reads), so a caller talking to someone else in the room is never heard.
 * - `open` — the window is held. Every final the transcriber commits is HELD
 *   rather than answered, and the caption the client shows is everything held
 *   so far plus the live partial, so a turn spanning three pauses reads as one.
 * - `committing` — the button was released while the transcriber still had an
 *   utterance open. The transcriber is asked to end it NOW (the same
 *   `forceEndOfTurn` a `userTurnLimit` uses) and the turn is answered when that
 *   final lands — or, if it never does, after {@link MANUAL_COMMIT_FINAL_TIMEOUT_MS}
 *   on the last partial, which is the best record of what was said.
 *
 * **A final that lands while `closed` is DROPPED.** It is the tail of a turn
 * that was already answered (a final later than the commit deadline) or thrown
 * away (`clear`), and holding it would open the NEXT turn with words from the
 * previous one. That one rule is what makes a late final safe everywhere, so
 * nothing else here has to track which utterance a final belongs to.
 *
 * What this module does NOT do is interrupt the agent: opening a turn is the
 * push-to-talk barge-in, and aborting a reply belongs to the transport, which
 * owns the turn it would abort (`pipeline-transport-commands.ts`).
 *
 * @module
 */

import type { TurnDetectionMode } from "@alexkroman1/aai";
import { createRestartableTimer } from "../_timer.ts";
import type { Logger } from "../runtime-config.ts";

/**
 * How long a commit waits for the transcriber's final before answering on the
 * last partial instead.
 *
 * AssemblyAI answers a `ForceEndpoint` with its final well inside this; the
 * bound exists for a provider that cannot end a turn on demand at all (the
 * transport logs that once) and for a final lost on the wire. NOT MEASURED as
 * a latency trade: it is the price of a commit only on those two paths, where
 * the alternative is a turn that is never answered.
 *
 * @internal
 */
export const MANUAL_COMMIT_FINAL_TIMEOUT_MS = 1500;

/** The push-to-talk turn state — see this module's doc. @internal */
export interface ManualTurn {
  /** `turnDetection: "manual"`. When false every member below is inert. */
  readonly enabled: boolean;
  /** May the caller's audio reach the transcriber right now? */
  isOpen(): boolean;
  /** Open a turn. A commit still waiting on its final is answered first. */
  start(): void;
  /** Close the turn and answer everything heard inside it. */
  commit(): void;
  /** Close the turn and throw away everything heard inside it. */
  clear(): void;
  /**
   * An interim transcript arrived. Answers the caption to show — what is held
   * plus this partial — or `undefined` when no turn is open.
   */
  onPartial(text: string): string | undefined;
  /** A committed transcript arrived: hold it, answer it, or drop it. */
  onFinal(text: string): void;
  /** Forget everything — a conversation reset, or the session ending. */
  reset(): void;
}

/**
 * The default policy's value: nothing is manual, the microphone is always
 * open, and the STT handlers answer each final themselves.
 *
 * @internal
 */
export const AUTO_TURN_DETECTION: ManualTurn = {
  enabled: false,
  isOpen: () => true,
  start: () => undefined,
  commit: () => undefined,
  clear: () => undefined,
  onPartial: () => undefined,
  onFinal: () => undefined,
  reset: () => undefined,
};

type ManualTurnPhase = "closed" | "open" | "committing";

/**
 * Bind push-to-talk to one session, or answer {@link AUTO_TURN_DETECTION} for
 * an agent that did not ask for it.
 *
 * @internal
 */
export function createManualTurn(
  policy: TurnDetectionMode | undefined,
  deps: {
    /** Ask the transcriber to end the utterance it has open, now. */
    forceEndOfTurn(): void;
    /** Answer `text` as the caller's turn — report it and run the reply. */
    commitUserTurn(text: string): void;
    /** False once the transport terminated: a late timer answers nothing. */
    isActive(): boolean;
    log: Logger;
    sid: string;
    /** Override {@link MANUAL_COMMIT_FINAL_TIMEOUT_MS} — specs only. */
    finalTimeoutMs?: number | undefined;
  },
): ManualTurn {
  if (policy !== "manual") return AUTO_TURN_DETECTION;
  const { log, sid } = deps;
  let phase: ManualTurnPhase = "closed";
  // Finals already committed inside the open turn, in order.
  let held: string[] = [];
  // The transcriber's open utterance, if it has reported one since the last
  // final — the fallback transcript when a commit's final never arrives.
  let partial = "";
  // Set when a turn was answered on its partial while that utterance's final
  // was still owed: the final is the same words, so the next one is dropped
  // rather than opening the following turn with them.
  let owedFinal = false;

  const deadline = createRestartableTimer(() => {
    if (phase !== "committing" || !deps.isActive()) return;
    log.info("Push-to-talk commit answered without a final", { sid });
    answer(true);
  });

  /** Close the turn and answer what it holds (plus the partial, if asked). */
  function answer(withPartial: boolean): void {
    deadline.clear();
    const parts = withPartial && partial !== "" ? [...held, partial] : held;
    owedFinal = withPartial && partial !== "";
    const text = parts.join(" ").trim();
    phase = "closed";
    held = [];
    partial = "";
    if (text === "") {
      log.info("Push-to-talk turn committed with nothing said", { sid });
      return;
    }
    deps.commitUserTurn(text);
  }

  function forget(): void {
    deadline.clear();
    phase = "closed";
    held = [];
    partial = "";
    owedFinal = false;
  }

  return {
    enabled: true,
    isOpen: () => phase === "open",
    start(): void {
      // Pressed again before the last release was answered: answer it now on
      // what it has, rather than folding two turns into one.
      if (phase === "committing") answer(true);
      phase = "open";
      held = [];
      partial = "";
    },
    commit(): void {
      if (phase !== "open") return;
      // Nothing outstanding in the transcriber: every word is already held.
      if (partial === "") {
        answer(false);
        return;
      }
      phase = "committing";
      deps.forceEndOfTurn();
      deadline.arm(deps.finalTimeoutMs ?? MANUAL_COMMIT_FINAL_TIMEOUT_MS);
    },
    clear(): void {
      if (phase === "closed") return;
      const outstanding = partial !== "";
      forget();
      // End the utterance the transcriber is still building, and owe its final
      // to the bin — so it is dropped even if the caller presses again before
      // it lands, rather than opening the next turn with discarded words.
      owedFinal = outstanding;
      if (outstanding) deps.forceEndOfTurn();
    },
    onPartial(text: string): string | undefined {
      if (phase === "closed") return undefined;
      // The transcriber reports in order, so a partial of the NEW utterance
      // means an owed final from the last one is not coming.
      owedFinal = false;
      partial = text;
      return [...held, text].join(" ");
    },
    onFinal(text: string): void {
      if (phase === "closed" || owedFinal) {
        owedFinal = false;
        log.debug("Push-to-talk final outside a turn dropped", { sid, text });
        return;
      }
      held.push(text);
      partial = "";
      if (phase === "committing") answer(false);
    },
    reset: forget,
  };
}
