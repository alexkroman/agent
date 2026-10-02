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
 * owns the turn it would abort (`../commands.ts`).
 *
 * ## A statechart, with the owed final as a REGION
 *
 * The three phases above are the `turn` region; the commit deadline is an
 * `after` on `committing`, so leaving that state cancels it and the callback no
 * longer re-checks the phase it was armed in. Beside them sat `owedFinal`, a
 * flag with six write sites cutting across all three phases: set when a turn
 * was answered on its partial (or cleared mid-utterance) while that
 * utterance's final was still owed, so the final — the same words — is dropped
 * rather than opening the next turn with them. It outlives the turn it belongs
 * to (it is set on the way INTO `closed`, and survives a press), which is why
 * it is a parallel `owed` region (`none` / `expectingFinal`) rather than a
 * substate. The turn region tells it what is owed by raising `OWE_FINAL` /
 * `OWE_NOTHING`; a final, held or dropped, always settles it.
 *
 * The text — the held finals and the live partial — is context: the machine
 * decides WHEN it is answered, held or dropped, and the guards read it.
 *
 * @module
 */

import type { TurnDetectionMode } from "@alexkroman1/aai";
import { assign, createActor, enqueueActions, raise, setup, stateIn } from "xstate";
import type { Logger } from "../../../logger.ts";

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

/** What one session's push-to-talk turn needs from the transport. */
type ManualTurnDeps = {
  /** Ask the transcriber to end the utterance it has open, now. */
  forceEndOfTurn(): void;
  /** Answer `text` as the caller's turn — report it and run the reply. */
  commitUserTurn(text: string): void;
  /** False once the transport terminated: a late deadline answers nothing. */
  isActive(): boolean;
  log: Logger;
  sid: string;
  /** Override {@link MANUAL_COMMIT_FINAL_TIMEOUT_MS} — specs only. */
  finalTimeoutMs?: number | undefined;
};

/** Everything that happens to a push-to-talk turn. */
type ManualTurnEvent =
  /** `user_turn_start` — the button went down. */
  | { type: "PRESS" }
  /** `user_turn_commit` — the button came up. */
  | { type: "RELEASE" }
  /** `user_turn_clear` — throw the turn away. */
  | { type: "CLEAR" }
  | { type: "PARTIAL"; text: string }
  | { type: "FINAL"; text: string }
  /** A conversation reset, or the session ending. */
  | { type: "RESET" }
  /** Raised by the `turn` region: the open utterance's final is (not) owed. */
  | { type: "OWE_FINAL" }
  | { type: "OWE_NOTHING" };

type ManualTurnContext = {
  deps: ManualTurnDeps;
  /** Finals already committed inside the open turn, in order. */
  held: string[];
  /**
   * The transcriber's open utterance, if it has reported one since the last
   * final — the fallback transcript when a commit's final never arrives.
   */
  partial: string;
};

const manualTurnMachine = setup({
  types: {} as {
    context: ManualTurnContext;
    input: ManualTurnDeps;
    events: ManualTurnEvent;
  },
  delays: {
    finalTimeout: ({ context }) => context.deps.finalTimeoutMs ?? MANUAL_COMMIT_FINAL_TIMEOUT_MS,
  },
  guards: {
    /** Every word is already held: nothing is outstanding in the transcriber. */
    nothingOutstanding: ({ context }) => context.partial === "",
    /** The final arriving is one already answered on its partial, or binned. */
    owesFinal: stateIn({ owed: "expectingFinal" }),
    isActive: ({ context }) => context.deps.isActive(),
  },
  actions: {
    /** Ask the transcriber to end its open utterance now. */
    forceEnd: ({ context }) => context.deps.forceEndOfTurn(),
    beginTurn: assign({ held: [], partial: "" }),
    setPartial: assign({
      partial: ({ context, event }) => (event.type === "PARTIAL" ? event.text : context.partial),
    }),
    hold: assign({
      held: ({ context, event }) =>
        event.type === "FINAL" ? [...context.held, event.text] : context.held,
      partial: "",
    }),
    /**
     * Close the turn and answer what it holds — plus the partial when
     * `withPartial`, in which case that utterance's final is now OWED.
     */
    answer: enqueueActions(({ context, enqueue }, params: { withPartial: boolean }) => {
      const { deps, held, partial } = context;
      const owes = params.withPartial && partial !== "";
      const text = (owes ? [...held, partial] : held).join(" ").trim();
      enqueue.assign({ held: [], partial: "" });
      enqueue.raise({ type: owes ? "OWE_FINAL" : "OWE_NOTHING" });
      enqueue(() => {
        if (text === "") {
          deps.log.info("Push-to-talk turn committed with nothing said", { sid: deps.sid });
          return;
        }
        deps.commitUserTurn(text);
      });
    }),
    /**
     * Throw the turn away. End the utterance the transcriber is still building,
     * and owe its final to the bin — so it is dropped even if the caller presses
     * again before it lands, rather than opening the next turn with discarded
     * words.
     */
    discard: enqueueActions(({ context, enqueue }) => {
      const outstanding = context.partial !== "";
      enqueue.assign({ held: [], partial: "" });
      enqueue.raise({ type: outstanding ? "OWE_FINAL" : "OWE_NOTHING" });
      if (outstanding) enqueue(() => context.deps.forceEndOfTurn());
    }),
    forget: enqueueActions(({ enqueue }) => {
      enqueue.assign({ held: [], partial: "" });
      enqueue.raise({ type: "OWE_NOTHING" });
    }),
    /**
     * The transcriber reports in order, so a partial of the NEW utterance means
     * an owed final from the last one is not coming.
     */
    owedNotComing: raise({ type: "OWE_NOTHING" }),
    logDropped: ({ context, event }) =>
      context.deps.log.debug("Push-to-talk final outside a turn dropped", {
        sid: context.deps.sid,
        text: event.type === "FINAL" ? event.text : "",
      }),
    logNoFinal: ({ context }) =>
      context.deps.log.info("Push-to-talk commit answered without a final", {
        sid: context.deps.sid,
      }),
  },
}).createMachine({
  id: "manualTurn",
  type: "parallel",
  context: ({ input }) => ({ deps: input, held: [], partial: "" }),
  states: {
    /** The three phases in this module's doc. */
    turn: {
      initial: "closed",
      on: { RESET: { target: ".closed", actions: "forget" } },
      states: {
        /**
         * The microphone is silenced. A final here is DROPPED (the module doc's
         * one rule), and a partial is not captioned.
         */
        closed: {
          on: {
            PRESS: { target: "open", actions: "beginTurn" },
            FINAL: { actions: "logDropped" },
          },
        },
        /** The window is held: finals are HELD rather than answered. */
        open: {
          on: {
            // Pressed while already held: the turn starts over.
            PRESS: { actions: "beginTurn" },
            RELEASE: [
              {
                guard: "nothingOutstanding",
                target: "closed",
                actions: { type: "answer", params: { withPartial: false } },
              },
              { target: "committing", actions: "forceEnd" },
            ],
            CLEAR: { target: "closed", actions: "discard" },
            PARTIAL: { actions: ["setPartial", "owedNotComing"] },
            FINAL: [{ guard: "owesFinal", actions: "logDropped" }, { actions: "hold" }],
          },
        },
        /**
         * Released mid-utterance: waiting on the final the transcriber was asked
         * for. The deadline is this state's — leaving it, however, cancels it.
         */
        committing: {
          after: {
            finalTimeout: {
              // A session that ended meanwhile answers nothing.
              guard: "isActive",
              target: "closed",
              actions: ["logNoFinal", { type: "answer", params: { withPartial: true } }],
            },
          },
          on: {
            // Pressed again before the last release was answered: answer it now
            // on what it has, rather than folding two turns into one.
            PRESS: {
              target: "open",
              actions: [{ type: "answer", params: { withPartial: true } }, "beginTurn"],
            },
            CLEAR: { target: "closed", actions: "discard" },
            PARTIAL: { actions: ["setPartial", "owedNotComing"] },
            FINAL: [
              { guard: "owesFinal", actions: "logDropped" },
              {
                target: "closed",
                actions: ["hold", { type: "answer", params: { withPartial: false } }],
              },
            ],
          },
        },
      },
    },
    /**
     * Whether the transcriber still owes the final of an utterance that was
     * already answered on its partial (or discarded). A final — held or
     * dropped — always settles it.
     */
    owed: {
      initial: "none",
      on: { OWE_FINAL: ".expectingFinal", OWE_NOTHING: ".none", FINAL: ".none" },
      states: { none: {}, expectingFinal: {} },
    },
  },
});

/**
 * Bind push-to-talk to one session, or answer {@link AUTO_TURN_DETECTION} for
 * an agent that did not ask for it.
 *
 * @internal
 */
export function createManualTurn(
  policy: TurnDetectionMode | undefined,
  deps: ManualTurnDeps,
): ManualTurn {
  if (policy !== "manual") return AUTO_TURN_DETECTION;
  const actor = createActor(manualTurnMachine, { input: deps }).start();
  return {
    enabled: true,
    isOpen: () => actor.getSnapshot().matches({ turn: "open" }),
    start: () => actor.send({ type: "PRESS" }),
    commit: () => actor.send({ type: "RELEASE" }),
    clear: () => actor.send({ type: "CLEAR" }),
    onPartial(text: string): string | undefined {
      if (actor.getSnapshot().matches({ turn: "closed" })) return undefined;
      actor.send({ type: "PARTIAL", text });
      return [...actor.getSnapshot().context.held, text].join(" ");
    },
    onFinal: (text: string) => actor.send({ type: "FINAL", text }),
    reset: () => actor.send({ type: "RESET" }),
  };
}
