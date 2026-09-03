// Copyright 2026 the AAI authors. MIT license.
/**
 * A rollback is an INVERSE, at every depth including the cap.
 *
 * `dropTrailingUser` exists to undo one push: the injected prompt (a
 * false-interruption resume, a silence nudge, `injectTurn`) that
 * `pipeline-turn-body.ts` writes BEFORE the LLM stream runs and that
 * `persistBargeIn` rolls back when the turn left no trace at all. The claim it
 * makes is total — "so this can never eat a message it did not write" — and the
 * only way to state that is as an equality against the history as it stood
 * before the push.
 *
 * That equality was FALSE at exactly one depth, and it was found by the
 * differential in `session-history-replay-equivalence.test.ts` (whose module doc
 * recorded it) rather than by either module's unit suite. `pushConversation`
 * caps the window, trimming from the FRONT when it is full; `dropTrailingUser`
 * POPS from the back. So a rollback landing at the cap undid the append and not
 * the eviction the append caused: push at 200 trims the oldest message and lands
 * at 200, the pop leaves 199, and the trimmed message is gone for the rest of the
 * call. A synthetic prompt — a message the caller never said — permanently cost
 * one real conversation turn, and nothing in the system could see it: both views
 * are the right SHAPE afterwards, one turn shallower.
 *
 * ## Why a property, and why it is an oracle
 *
 * The defect is a relation between two operations over a state neither of them
 * can see the whole of. A unit test states the relation for one hand-chosen
 * depth, and every depth anybody wrote by hand was well under 200 — the shape
 * that fails needs ~200 prior messages of the right kinds, which is the corpus
 * nobody types. The oracle is not a second implementation: it is a SNAPSHOT of
 * the two views taken before the push, which is what "inverse" means and is not
 * derived from the code under test.
 *
 * Both arms drive production code. The first calls the module's own contract
 * (the push pair, as `pipeline-turn-body.ts:51-52` writes it, then the drop);
 * the second goes through the real rollback site, `createTurnOutcome`'s
 * `persistBargeIn` with a `syntheticPrompt` and a turn that left no trace, so
 * `leftNoTrace` and the `historyCurrent` gate are production code too.
 *
 * ## Why this is an INTEGRATION test
 *
 * No clock, socket, disk or provider — the TTS fake records text and
 * synthesizes nothing, `stt` is `null` — so nothing here needs the scenario
 * tier. It is here for the reason `pipeline-fuzz.integration.test.ts` states
 * for itself: **it is too slow for the 5s unit budget**, being several modules
 * driven in memory, which is that tier's membership rule anyway.
 *
 * It began in `transports/` and timed out in CI, on `main` as well as on a
 * branch. The cost is written down two screens below: `numRuns` went 20 -> 80
 * to give the floors a distribution they could actually describe, which took
 * the body from 635ms to ~2.6s where it was measured — and 3.2-4.0s on other
 * developer machines, against a 5s deadline, on a runner sharing itself with
 * 205 other test files. Lowering `numRuns` back is the one fix NOT available:
 * that comment records an ~8% failure rate for the floors at 20 draws, so it
 * would buy the green by making the assertions stop meaning anything.
 */

import type { Message } from "@alexkroman1/aai";
import type { TtsSession, Unsubscribe } from "@alexkroman1/aai/host-internal";
import { DEFAULT_MAX_HISTORY } from "@alexkroman1/aai/internal";
import type { ModelMessage } from "ai";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { createPipelineHistory, type PipelineHistory } from "../transports/pipeline-history.ts";
import type { PipelineProviderSessions } from "../transports/pipeline-providers.ts";
import { createTurnGate } from "../transports/pipeline-turn-gate.ts";
import { createTurnOutcome } from "../transports/pipeline-turn-outcome.ts";
import type { TransportCallbacks } from "../transports/types.ts";

/**
 * One thing that can happen to a history between rollbacks.
 *
 * The repertoire is chosen for what it does to the two CAPS rather than for
 * conversational realism: `tools` is the only shape that puts a `tool` message
 * in the LLM view, which is what makes `capLlm`'s pair healing (a leading `tool`
 * message shifted off after the trim) part of what a rollback has to restore,
 * and `steps` is the only multi-message push, which a rollback may NOT restore
 * because one pop cannot answer for two appends.
 */
type Fill =
  /** A committed user turn — `pipeline-turn-body.ts:51-52`, both views. */
  | { readonly t: "user" }
  /** A spoken reply — `finishSpokenTurn`, both views. */
  | { readonly t: "reply" }
  /** A tool call and its result. LLM view only, and a PAIR. */
  | { readonly t: "tools" }
  /** A turn's completed step messages — one push of `n`, LLM view only. */
  | { readonly t: "steps"; readonly n: number }
  /** Client-resent history on reconnect. */
  | { readonly t: "seed"; readonly n: number }
  /** A reply whose only content is non-replayable reasoning: pushes NOTHING. */
  | { readonly t: "reasoning" }
  /** "New Conversation" — both views cleared. */
  | { readonly t: "reset" };

const fillArb: fc.Arbitrary<Fill> = fc.oneof(
  // Weighted toward the two shapes that grow both views, because a script that
  // never reaches 200 messages cannot reach the defect at all.
  fc.constant<Fill>({ t: "user" }),
  fc.constant<Fill>({ t: "user" }),
  fc.constant<Fill>({ t: "reply" }),
  fc.constant<Fill>({ t: "reply" }),
  fc.constant<Fill>({ t: "tools" }),
  fc.constant<Fill>({ t: "reasoning" }),
  fc.constant<Fill>({ t: "reset" }),
  fc.integer({ min: 1, max: 3 }).map((n): Fill => ({ t: "steps", n })),
  fc.integer({ min: 1, max: 3 }).map((n): Fill => ({ t: "seed", n })),
);

/** States the corpus has to have REACHED, or the equality below is vacuous. */
type Reached = {
  rollbacks: number;
  atCapConversation: number;
  atCapLlm: number;
  toolHealedAtCap: number;
  belowCap: number;
};

const noReached = (): Reached => ({
  rollbacks: 0,
  atCapConversation: 0,
  atCapLlm: 0,
  toolHealedAtCap: 0,
  belowCap: 0,
});

/**
 * A TTS session that records and synthesizes nothing.
 *
 * Written out rather than cast, for the reason the sibling property in
 * `session-history-replay-equivalence.test.ts` gives: the interface is five
 * members and a cast stops reporting the moment one is added.
 */
function inertTts(): TtsSession {
  return {
    sendText: () => undefined,
    flush: () => undefined,
    cancel: () => undefined,
    on: (): Unsubscribe => () => undefined,
    close: () => Promise.resolve(),
  };
}

/** `stt: null` is the state `speakStartFailure`'s own doc describes. */
function providers(): PipelineProviderSessions {
  return {
    stt: null,
    tts: inertTts(),
    open: (): Promise<"ok" | "failed"> => Promise.resolve("ok"),
    unsubscribe: () => undefined,
    close: () => Promise.resolve(),
  };
}

const callbacks: TransportCallbacks = {
  report: () => undefined,
  onAudioChunk: () => undefined,
  onReplyStarted: () => undefined,
};

/** How the prompt gets rolled back: the module's door, or the session's. */
type Door = "history" | "bargeIn";

/**
 * Push a synthetic prompt exactly as a turn does, roll it back through `door`,
 * and answer both views before and after.
 *
 * `serial` makes every prompt's text unique within a run, so a rollback can
 * never match a message it did not write — which is the OTHER half of
 * `dropTrailingUser`'s contract, and one this property would otherwise be free
 * to satisfy by matching the wrong message.
 */
function rollback(
  history: PipelineHistory,
  drop: (prompt: string) => void,
  prompt: string,
): {
  before: readonly [readonly Message[], readonly ModelMessage[]];
  after: readonly [readonly Message[], readonly ModelMessage[]];
} {
  const before = [[...history.conversation], [...history.llm]] as const;
  // `pipeline-turn-body.ts:51-52`, verbatim: two pushes, one per view, each
  // capping its own array. That the two views cap INDEPENDENTLY is why a
  // rollback has to remember what it evicted per view.
  history.pushConversation({ role: "user", content: prompt });
  history.pushLlm({ role: "user", content: prompt });
  drop(prompt);
  return { before, after: [[...history.conversation], [...history.llm]] as const };
}

/**
 * A view as a list of one string per message, in order.
 *
 * Every message this driver writes carries a unique serial in its text, so this
 * is injective over a run: two views are equal exactly when their digests are.
 * Not the message OBJECTS, because a deep equality over ~400 of them per step
 * and ~10,000 steps a run is most of the suite's budget.
 */
const digest = (msgs: readonly (Message | ModelMessage)[]): string[] =>
  msgs.map((m) => {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return `${m.role}:${content}`;
  });

/** One view's divergence, named by what the rollback LOST and what it invented. */
type Divergence = {
  door: Door;
  step: number;
  view: "conversation" | "llm";
  lost: string[];
  gained: string[];
};

/**
 * The two digests as a set difference rather than as two 200-entry lists.
 *
 * A failure here is one message deep in a full window, so the useful report is
 * its NAME: `lost: ["assistant:step m0"]` says which turn the rollback ate,
 * where an ordered inequality of two long arrays says only that they differ.
 */
function divergence(
  door: Door,
  step: number,
  view: "conversation" | "llm",
  before: readonly string[],
  after: readonly string[],
): Divergence | null {
  const b = new Set(before);
  const a = new Set(after);
  const lost = before.filter((x) => !a.has(x));
  const gained = after.filter((x) => !b.has(x));
  if (lost.length === 0 && gained.length === 0 && before.length === after.length) return null;
  return { door, step, view, lost, gained };
}

/** A reply whose reasoning carries no provider metadata — `pushLlm` drops it. */
const unreplayableReasoning = (id: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "reasoning", text: `thinking ${id}` }],
});

/**
 * Run `script` cyclically, rolling a prompt back after every step, and answer
 * the FIRST step at which a view did not come back as it was.
 *
 * The comparison is answered rather than asserted here because Biome's
 * `noMisplacedAssertion` reads the enclosing callee: an `expect` in a helper is
 * an error, and the remedy is the better shape anyway — the test asserts one
 * value and fast-check shrinks the script that produced it.
 */
function driveRollbacks(script: readonly Fill[], door: Door, reached: Reached): Divergence | null {
  const history = createPipelineHistory();
  const gate = createTurnGate();
  const outcome = createTurnOutcome({
    history,
    callbacks,
    providers: providers(),
    gate,
    errorPhrase: "sorry",
    startFailurePhrase: "cannot start",
    drainTts: () => Promise.resolve(),
    sendTtsText: () => undefined,
  });
  let serial = 0;
  const id = (): string => `m${serial++}`;

  /**
   * The real rollback site. `stepMessages: []` plus `heardChars: 0` is exactly
   * `leftNoTrace` — the only condition under which `persistBargeIn` rolls a
   * prompt back — so this arm exercises that computation rather than restating
   * its conclusion.
   */
  const dropViaBargeIn = (prompt: string): void => {
    outcome.persistBargeIn({
      historyEpoch: gate.historyEpoch(),
      accumulated: "tail-nobody-heard",
      heardChars: 0,
      persistedLen: 0,
      stepMessages: [],
      syntheticPrompt: prompt,
    });
  };
  const drop = door === "history" ? (p: string) => history.dropTrailingUser(p) : dropViaBargeIn;

  const apply = (fill: Fill): void => {
    switch (fill.t) {
      case "user": {
        const t = `u${id()}`;
        history.pushConversation({ role: "user", content: t });
        history.pushLlm({ role: "user", content: t });
        break;
      }
      case "reply": {
        const t = `a${id()}`;
        history.pushConversation({ role: "assistant", content: t });
        history.pushLlm({ role: "assistant", content: t });
        break;
      }
      case "tools": {
        const callId = `t${id()}`;
        history.pushLlm(
          {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: callId, toolName: "lookup", input: {} }],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: callId,
                toolName: "lookup",
                output: { type: "text", value: callId },
              },
            ],
          },
        );
        break;
      }
      case "steps":
        history.pushLlm(
          ...Array.from(
            { length: fill.n },
            (): ModelMessage => ({
              role: "assistant",
              content: `step ${id()}`,
            }),
          ),
        );
        break;
      case "seed":
        history.seed(
          Array.from({ length: fill.n }, (): Message => ({ role: "user", content: `s${id()}` })),
        );
        break;
      case "reasoning":
        history.pushLlm(unreplayableReasoning(id()));
        break;
      case "reset":
        gate.invalidateAll();
        history.reset();
        break;
      default: {
        // A new `Fill` arm is a COMPILE error here rather than a shape the
        // driver silently skips, which would drop it out of every floor below.
        const unreachable: never = fill;
        throw new Error(`unknown fill ${JSON.stringify(unreachable)}`);
      }
    }
  };

  // 260 steps: enough that a script of nothing but growing turns overruns the
  // 200-message window on both views with room to keep rolling back at the cap,
  // while a reset-heavy one may never reach it — which is why the cap counters
  // below are floored rather than asserted.
  for (let i = 0; i < 260; i++) {
    apply(script[i % script.length] as Fill);
    const leadingToolAtCap =
      history.llm.length >= DEFAULT_MAX_HISTORY && history.llm[1]?.role === "tool";
    const { before, after } = rollback(history, drop, `p${id()}`);
    reached.rollbacks++;
    if (before[0].length >= DEFAULT_MAX_HISTORY) reached.atCapConversation++;
    if (before[1].length >= DEFAULT_MAX_HISTORY) reached.atCapLlm++;
    // The trim exposed a `tool` message at the front, so `capLlm` shifted it as
    // well — a rollback owes back both the capped message AND the healed pair
    // half, and restoring only the first leaves the view one message short.
    if (leadingToolAtCap) reached.toolHealedAtCap++;
    if (before[0].length < DEFAULT_MAX_HISTORY && before[1].length < DEFAULT_MAX_HISTORY) {
      reached.belowCap++;
    }
    const diverged =
      divergence(door, i, "conversation", digest(before[0]), digest(after[0])) ??
      divergence(door, i, "llm", digest(before[1]), digest(after[1]));
    // Answered at the FIRST divergence: past one, every later step inherits the
    // same missing message, so 60 more reports would name one bug 60 times.
    if (diverged) return diverged;
  }
  return null;
}

describe("an injected prompt rolled back leaves the history as it found it", () => {
  /**
   * Floors are set under the OBSERVED MINIMUM over 20 runs, with the range
   * beside each — never a fraction of the mean. What a driven history reaches is
   * correlated within a run (one script decides all 260 steps) rather than
   * independent per step, so these distributions have long left tails.
   */
  const reached = noReached();
  /**
   * Both doors inside ONE property rather than a `test.each` arm each, because
   * the floors below are a claim about the CORPUS: split across two tests they
   * would either be asserted twice over half a corpus each, or asserted in a
   * third test that silently depends on the other two having run first.
   */
  const doors: readonly Door[] = ["history", "bargeIn"];

  test("at every depth, through both doors", () => {
    fc.assert(
      fc.property(fc.array(fillArb, { minLength: 1, maxLength: 6 }), (script) => {
        const diverged = doors.map((door) => driveRollbacks(script, door, reached));
        expect(diverged, "a rolled-back prompt did not leave the history as it found it").toEqual(
          doors.map(() => null),
        );
      }),
      // 80 rather than fast-check's default, and rather than the 20 this ran at
      // for its first month. The counters below AGGREGATE over the property's
      // runs, so `numRuns` is what decides how heavy their left tail is — and at
      // 20 the tail reached states this suite exists to require. Measured over
      // 24 consecutive runs at 20: `toolHealedAtCap` came out **0 twice**
      // against a floor of `> 10`, i.e. an ~8% failure rate on a green tree, and
      // `atCapConversation` produced the 144 that failed a real CI job against a
      // floor of 200 whose recorded range started at 442. Neither number was
      // wrong when it was taken; 20 draws was too few for the range to describe
      // the unluckiest run.
      //
      // Four times the draws costs 635ms -> ~2.6s against the unit tier's 5s
      // budget, and it is the fix that makes the floors mean something rather
      // than lowering them until they stop firing: a floor under a distribution
      // whose minimum is zero cannot be set at all.
      { numRuns: 80 },
    );

    // `ROLLBACK_FUZZ_COVERAGE=1` prints the table, the way the pipeline, S2S and
    // replay-equivalence properties do. It is how the actuals below were taken,
    // and how the next person re-takes them.
    if (process.env.ROLLBACK_FUZZ_COVERAGE === "1") console.log(JSON.stringify(reached));
    // Every range below was RE-TAKEN over 14 consecutive runs at `numRuns: 80`,
    // and each floor sits under the OBSERVED MINIMUM of its range — never a
    // fraction of the mean, because what one script reaches is correlated across
    // all 260 of its steps rather than independent per step, so these
    // distributions have long left tails.
    //
    // **The previous ranges were taken at `numRuns: 20` and two of these floors
    // were unsatisfiable there**, which is why the count moved rather than the
    // numbers alone. Measured over 24 consecutive runs at 20: `toolHealedAtCap`
    // came out **0 twice** against a floor of `> 10` — a state the corpus simply
    // failed to reach on ~8% of green runs, so no positive floor was settable at
    // all — and `atCapConversation` produced the **144** that failed a CI job
    // against a floor of 200 whose recorded range started at 442. Neither
    // recorded range was wrong when taken; 20 draws was too few to describe the
    // unluckiest run. See the `numRuns` comment above.
    //
    // This first one is DETERMINISTIC on a green run — 80
    // `numRuns` x 2 doors x 260 steps — so it is a wiring check rather than a
    // reach claim: it fails if the loop, the door list, `numRuns` or the step
    // count is edited without the four floors below being re-taken.
    expect(reached.rollbacks, "no prompt was ever rolled back").toBeGreaterThan(40_000); // 41600-41600 over 14 runs (deterministic)
    // The whole defect lives here: a rollback whose push had to trim. Without
    // these two floors the equality is satisfied by a corpus that never fills a
    // window, which is every corpus anybody writes by hand.
    expect(reached.atCapConversation, "no rollback ever landed at the text cap").toBeGreaterThan(
      1200,
    ); // 2822-5170 over 14 runs
    expect(reached.atCapLlm, "no rollback ever landed at the LLM cap").toBeGreaterThan(4000); // 8072-11344 over 14 runs
    // Still the longest left tail of the five — it needs the `tools` fill AND a
    // full LLM window AND the trim to land on the call rather than the result —
    // so the floor sits under a THIRD of the minimum rather than near it. At
    // `numRuns: 20` this was the one that reached zero.
    expect(
      reached.toolHealedAtCap,
      "no rollback at the cap ever had a healed tool pair to restore",
    ).toBeGreaterThan(200); // 672-3230 over 14 runs
    // The control: a script that resets on every step never fills anything, so
    // most rollbacks are the ordinary below-the-cap kind the unit suite pins. A
    // corpus that lost this would be one where the equality is only ever
    // checked at the boundary.
    expect(reached.belowCap, "every rollback landed at a full window").toBeGreaterThan(20_000); // 30210-33528 over 14 runs
  });
});
