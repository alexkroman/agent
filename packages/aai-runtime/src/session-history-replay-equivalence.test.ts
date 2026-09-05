// Copyright 2026 the AAI authors. MIT license.
/**
 * The resume seam's DEFINING property: what a session remembers must survive
 * being read back out of its own log.
 *
 * Two modules reconstruct one conversation, and on a reconnect the output of the
 * second BECOMES the state of the first:
 *
 * ```
 * live:   transport pushes ──────────────────→ createPipelineHistory().conversation
 *              │  (pipeline-history.ts)
 *              └─ callbacks.report(event) ──→ SessionEventStream
 *                                                 │
 *  resume:                        historyFromEvents / messagesFromEvents
 *                                     (session-event-history.ts)
 *                                                 │
 *                          core.restoreHistory ──→ transport.seedHistory
 *                                                 └→ history.seed(msgs)   ← the same array
 * ```
 *
 * `runtime-session-stream.ts:93` → `session-core.ts:307-310` →
 * `pipeline-transport.ts:428-431` → `pipeline-history.ts:249`. So a divergence
 * between the two is not an aesthetic mismatch: it is context the model GAINS or
 * LOSES at a reconnect, and it compounds, because every reconnect re-seeds.
 *
 * ## What decides which side is right
 *
 * State it plainly, because it is the difference between an oracle and a mirror.
 * `messagesFromEvents` has a THIRD copy of its own rule — `session-core.ts:203-222`,
 * whose live event dispatch appends on `*-transcript.committed`, clears on reset
 * and front-trims at `DEFAULT_MAX_HISTORY` — so "these two agree" would be a
 * consistency check between two copies of one loop, and three implementations
 * agreeing is stronger evidence than two while still being no specification.
 * **A green differential is not the claim that either side is right**: two
 * implementations wrong the same way pass it. This repo has already paid for
 * that, and `eval/workflow-engine.ts:282-284` records the bill — a shared
 * mistake "made the two implementations of one `WdkAdapter` agree — on the wrong
 * semantic — which is worth recording, because agreement between two
 * implementations is exactly what a differential spec looks for and it is not
 * the same claim as either of them being right."
 *
 * So the agreement half is checked against a THIRD sequence that is not a
 * reconstruction at all — `Driven.ledger`, the driver's note of what the session
 * DID, appended at the emit/push sites themselves. Both reconstructions are
 * compared to it as well as to each other, which is what makes the agreement
 * half an oracle rather than a mirror. Its one rule of its own ("a reset
 * clears") is the single thing all three implementations state and each
 * package's unit suite pins deterministically.
 *
 * The DIVERGENCE half is an oracle, because each divergent site has a module doc
 * that rules on it independently of the other implementation:
 *
 * | shape | live | replay | who says so |
 * | --- | --- | --- | --- |
 * | interrupted reply | `"<heard> [interrupted]"` | nothing | `session-event-history.ts:23-29` — deliberate, "the cheap direction" |
 * | synthetic prompt | the prompt, if its turn produced something | nothing | `pipeline-transport.ts:421-424` — kept "out of the user transcript" |
 * | failure phrase | nothing | nothing | `sdk/protocol-events.ts` — the `recovery` tag |
 *
 * ## The third row WAS a defect, and closing it is what the tag is for
 *
 * `pipeline-turn-outcome.ts` rules `history / ctx.messages: never` for both
 * failure phrases, with the reason measured: *"teaching the model that its own
 * replies open with apologies (or with filler) is how it starts producing them
 * unprompted."* Its transcript row reads `FINAL` — deliberately, so the UI
 * matches what the caller heard. `messagesFromEvents` read exactly that event,
 * so the two rules composed into the one outcome both modules forbid: a phrase
 * kept out of history for a whole call, then put INTO it by the first reconnect
 * via `seedHistory` — and into `ctx.messages` on the very call the caller heard
 * it. Nothing on the wire told a failure phrase from a reply; both are
 * `agent-transcript.committed`.
 *
 * A discriminating field closed it — `recovery?: "turn-failed" |
 * "session-failed"`, read by the one `historyMessageOf` that all three former
 * copies of the rule now call. So this property is a live ORACLE on that rule
 * rather than a record of the old boundary: what the replayed side CONTAINS of
 * `REPLAY_ONLY_KINDS` is now permanently empty — asserted rather than deleted,
 * so a regression reddens here — and over-tagging a reply fails both halves.
 *
 * ## One more thing the property found, since FIXED
 *
 * `dropTrailingUser` POPPED where `pushConversation` had already CAPPED, so an
 * injected prompt rolled back while the live window was full cost the oldest
 * real turn permanently. A push records what it evicted now, and
 * `integration/pipeline-history-rollback.integration.test.ts` states the inverse
 * over generated depths. This property is not that claim and never was: it
 * compares TAILS because the two sides trim DIFFERENT sequences, which is true
 * of correct code — the lost message merely made a first draft comparing
 * LENGTHS fire on code that was otherwise healthy.
 *
 * ## Why a property
 *
 * Both modules' unit suites are complete and neither can see this: each states a
 * claim about its own output for a hand-chosen input, and the defect is a
 * relation between the two over a whole session. The interesting inputs are the
 * ones nobody writes by hand — a barge-in whose caller heard nothing, a synthetic
 * prompt whose turn was stranded by a reset, a conversation past the 200-message
 * window.
 *
 * The driver runs the REAL emitters: `createTurnOutcome` over a real
 * `createPipelineHistory`, so `finishSpokenTurn`, `persistBargeIn`,
 * `speakRecovery` and `speakStartFailure` are production code. Only the three
 * two-line sites that live in other modules are restated, each cited above.
 *
 * ## Why this is a UNIT test
 *
 * No clock, socket, disk or provider. The TTS fake records text and synthesizes
 * nothing; the STT side is `null`, which is the state `speakStartFailure`'s own
 * doc describes ("the usual failure is STT missing while TTS connected").
 */

import type { Message } from "@alexkroman1/aai";
import type { TtsSession } from "@alexkroman1/aai/host-internal";
import { DEFAULT_MAX_HISTORY } from "@alexkroman1/aai/internal";
import type { SessionEvent, SessionEventBody } from "@alexkroman1/aai/protocol";
import { omitUndefined } from "@alexkroman1/aai/utils";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { recordingTts } from "./_pipeline-test-fakes.ts";
import { messagesFromEvents } from "./session-event-history.ts";
import { stampSessionEvent } from "./session-event-stream.ts";
import { createPipelineHistory } from "./transports/pipeline-history.ts";
import type { PipelineProviderSessions } from "./transports/pipeline-providers.ts";
import { createTurnGate } from "./transports/pipeline-turn-gate.ts";
import { createTurnOutcome } from "./transports/pipeline-turn-outcome.ts";
import type { TransportCallbacks } from "./transports/types.ts";

/**
 * Every message this driver can produce, keyed by the first character of its
 * text, so a message's PROVENANCE is readable off the message itself.
 *
 * The classification is what makes the boundary assertable without either
 * implementation being consulted about it: a leaked `[interrupted]` reply is a
 * `k` where only `u`/`a`/`g` may appear.
 */
const KIND = {
  /** A committed user turn. Both sides. */
  user: "u",
  /** A spoken reply. Both sides. */
  reply: "a",
  /** The greeting. Both sides. */
  greeting: "g",
  /** An injected prompt (resume / nudge / `injectTurn`). LIVE ONLY. */
  synthetic: "s",
  /** The heard prefix of an interrupted reply. LIVE ONLY. */
  interrupted: "k",
  /** `errorPhrase`. NEITHER side, since the `recovery` tag. */
  errorPhrase: "e",
  /** `startFailurePhrase`. NEITHER side, since the `recovery` tag. */
  startFailure: "f",
  /** A `user-transcript.updated` partial. NEITHER side. */
  userPartial: "p",
  /**
   * An `agent-transcript.updated` interim. NEITHER side.
   *
   * Tagged distinctly from the committed text it precedes, which is the
   * FAITHFUL choice and not a convenience: interim snapshots "legitimately
   * shrink and differ mid-string", and an interrupted reply's carry the dead-air
   * filler the caller heard and the record excludes
   * (`session-event-history.ts:16-21`).
   */
  agentInterim: "i",
} as const;

const SHARED_KINDS: ReadonlySet<string> = new Set([KIND.user, KIND.reply, KIND.greeting]);
const LIVE_ONLY_KINDS: ReadonlySet<string> = new Set([KIND.synthetic, KIND.interrupted]);
/**
 * The two recovery phrases. Named for the boundary they USED to sit on: both are
 * now spoken and captioned but enter no history, so what either reconstruction
 * contains of this set must be EMPTY. Kept as a live assertion rather than
 * deleted — an untagged phrase would land back here, which is the regression.
 */
const REPLAY_ONLY_KINDS: ReadonlySet<string> = new Set([KIND.errorPhrase, KIND.startFailure]);
/** The interim vocabulary, which neither reconstruction may ever contain. */
const INTERIM_KINDS: ReadonlySet<string> = new Set([KIND.userPartial, KIND.agentInterim]);

/** Fixed, because both phrases are session-scoped config rather than per-turn text. */
const ERROR_PHRASE = `${KIND.errorPhrase} sorry, I had trouble with that`;
const START_FAILURE_PHRASE = `${KIND.startFailure} I cannot start this call`;

const kindOf = (m: Message): string => m.content.slice(0, 1);
const contentsOf = (msgs: readonly Message[]): string[] => msgs.map((m) => m.content);
const keep = (msgs: readonly Message[], kinds: ReadonlySet<string>): Message[] =>
  msgs.filter((m) => kinds.has(kindOf(m)));

/** One turn of a pipeline session, as the transport really ends one. */
type Turn =
  | { t: "spoke" }
  | { t: "failed" }
  | { t: "greeting" }
  | { t: "startFailure" }
  | { t: "reset" }
  /** Barge-in: `heardWords` of the reply reached the caller, `steps` tools ran. */
  | { t: "interrupted"; heardWords: number; steps: number; persistedWords: number }
  /** An injected prompt whose turn then spoke — the prompt STAYS in live history. */
  | { t: "syntheticSpoke" }
  /** An injected prompt whose turn was barged in — kept or rolled back by trace. */
  | { t: "syntheticInterrupted"; heardWords: number; steps: number }
  /** A barge-in whose deferred persistence lands AFTER a reset, and is stranded. */
  | { t: "strandedBargeIn"; heardWords: number };

/** States the corpus has to have REACHED, or the assertions below are vacuous. */
type Reached = {
  spokenTurns: number;
  interruptedKept: number;
  interruptedSilent: number;
  strandedBargeIns: number;
  syntheticRetained: number;
  syntheticRolledBack: number;
  errorPhrases: number;
  startFailures: number;
  resets: number;
  backToBackUsers: number;
  liveTrims: number;
  replayTrims: number;
};

const noReached = (): Reached => ({
  spokenTurns: 0,
  interruptedKept: 0,
  interruptedSilent: 0,
  strandedBargeIns: 0,
  syntheticRetained: 0,
  syntheticRolledBack: 0,
  errorPhrases: 0,
  startFailures: 0,
  resets: 0,
  backToBackUsers: 0,
  liveTrims: 0,
  replayTrims: 0,
});

/**
 * A TTS session that records and synthesizes nothing.
 *
 * Written out rather than cast: the interface is five members, and a cast stops
 * reporting the moment one is added — which is the failure `as unknown as`
 * exists to cause (see `check:hatches` in the root guide).
 */
/**
 * `stt: null` is the documented start-failure state, not a shortcut — see
 * `TurnOutcome.speakStartFailure`, whose whole reason to exist is "STT missing
 * while TTS connected".
 */
function providersWith(tts: TtsSession): PipelineProviderSessions {
  return {
    stt: null,
    tts,
    open: (): Promise<"ok" | "failed"> => Promise.resolve("ok"),
    unsubscribe: () => undefined,
    close: () => Promise.resolve(),
  };
}

/** What one driven session produced, from both sides of the resume seam. */
type Driven = {
  /** `createPipelineHistory().conversation` — the live accumulator. */
  live: readonly Message[];
  /** `messagesFromEvents(log)` — the reader, which `seedHistory` would adopt. */
  replayed: readonly Message[];
  /** Text that reached TTS, i.e. what the caller actually heard. */
  spoken: readonly string[];
  /**
   * The driver's own record of every SHARED-kind message the session produced,
   * cleared at each reset — an arbiter neither implementation can be wrong in
   * the same way as, because it is a note of what the driver DID rather than a
   * third reconstruction of it. It is what upgrades the agreement half of this
   * property above a mirror.
   *
   * It encodes exactly one rule of its own, "a reset clears", which is the one
   * thing all THREE implementations state (`session-event-history.ts:50-53`,
   * `pipeline-history.ts:257`, `session-core.ts:160`) and which each package's
   * own unit suite pins deterministically.
   */
  ledger: readonly string[];
};

/**
 * Run `turns` through the real emitters and hand back both reconstructions.
 *
 * `serial` makes every generated message text unique within a run, which is what
 * lets the comparison below be an ordered identity rather than a multiset one.
 */
async function driveSession(turns: readonly Turn[], reached: Reached): Promise<Driven> {
  const log: SessionEvent[] = [];
  const history = createPipelineHistory();
  const gate = createTurnGate();
  const spoken: string[] = [];
  /**
   * The log, written the way the session writes it: `session-core.ts` forwards a
   * reported transport event to `emit`, and `session-commands.ts` emits
   * `session.reset` DIRECTLY — the two vocabularies are different types
   * (`TransportEventBody` has no reset), which is why the driver has both doors.
   */
  const emitToLog = (body: SessionEventBody): void => {
    log.push(stampSessionEvent(body));
  };
  const callbacks: TransportCallbacks = {
    report: (event) => {
      emitToLog(event);
    },
    onAudioChunk: () => undefined,
    onReplyStarted: () => undefined,
  };
  const outcome = createTurnOutcome({
    history,
    callbacks,
    providers: providersWith(recordingTts(spoken)),
    gate,
    errorPhrase: ERROR_PHRASE,
    startFailurePhrase: START_FAILURE_PHRASE,
    drainTts: () => Promise.resolve(),
    sendTtsText: (text) => spoken.push(text),
  });

  const ledger: string[] = [];
  let serial = 0;
  const text = (kind: string): string => `${kind}${serial++}`;
  const words = (kind: string, n: number): string =>
    n === 0 ? "" : [text(kind), ...Array.from({ length: n }, (_, i) => `w${i}`)].join(" ");

  /** `pipeline-user-speech.ts:452` + `pipeline-turn-body.ts:51`, as one unit. */
  const userTurn = (): void => {
    const t = text(KIND.user);
    // The partial that precedes every commit. In the log and in neither
    // reconstruction — the rule `session-event-history.ts` opens by stating.
    callbacks.report({ type: "user-transcript.updated", text: text(KIND.userPartial) });
    callbacks.report({ type: "user-transcript.committed", text: t });
    history.pushConversation({ role: "user", content: t });
    ledger.push(t);
  };
  /** What `sendTtsText` publishes while a reply streams. */
  const replyInterim = (): void => {
    callbacks.report({ type: "agent-transcript.updated", text: text(KIND.agentInterim) });
  };
  /** `pipeline-transport.ts:424` — pushed, never reported. */
  const syntheticTurn = (): string => {
    const t = text(KIND.synthetic);
    history.pushConversation({ role: "user", content: t });
    return t;
  };
  /** `pipeline-turn-outcome.ts:185-187` — announced AND pushed, as one unit. */
  const spokeReply = (): void => {
    const t = text(KIND.reply);
    outcome.finishSpokenTurn(t);
    ledger.push(t);
    reached.spokenTurns++;
  };
  /** `pipeline-transport-lifecycle.ts:188-189`. */
  const greet = (): void => {
    const t = text(KIND.greeting);
    callbacks.report({ type: "agent-transcript.committed", text: t });
    history.pushConversation({ role: "assistant", content: t });
    ledger.push(t);
  };
  /** `session-commands.ts:88-94` + `pipeline-transport.ts:443-451`. */
  const reset = (): void => {
    gate.invalidateAll();
    history.reset();
    emitToLog({ type: "session.reset" });
    ledger.length = 0;
    reached.resets++;
  };

  const bargeIn = (
    heardWords: number,
    steps: number,
    persistedWords: number,
    syntheticPrompt?: string,
  ): void => {
    replyInterim();
    const heard = words(KIND.interrupted, heardWords);
    // `heard` IS the prefix the code records, so `accumulated` extends it — the
    // tail is what the caller provably did not hear. Appended, never
    // substituted: a generator that shortened `accumulated` below `heard` would
    // be handing the code an impossible pair.
    const accumulated = `${heard} tail-nobody-heard`;
    outcome.persistBargeIn({
      historyEpoch: gate.historyEpoch(),
      accumulated,
      heardChars: heard.length,
      persistedLen: Math.min(persistedWords * 3, heard.length),
      stepMessages: Array.from({ length: steps }, (_, i) => ({
        role: "assistant" as const,
        content: `step ${i}`,
      })),
      ...omitUndefined({ syntheticPrompt }),
    });
    if (heardWords === 0) reached.interruptedSilent++;
    else reached.interruptedKept++;
  };

  for (const turn of turns) {
    const before = history.conversation.length;
    switch (turn.t) {
      case "spoke":
        userTurn();
        replyInterim();
        spokeReply();
        break;
      case "failed":
        userTurn();
        outcome.speakRecovery(true);
        reached.errorPhrases++;
        break;
      case "greeting":
        greet();
        break;
      case "startFailure":
        await outcome.speakStartFailure();
        reached.startFailures++;
        break;
      case "reset":
        reset();
        break;
      case "interrupted":
        userTurn();
        bargeIn(turn.heardWords, turn.steps, turn.persistedWords);
        break;
      case "syntheticSpoke": {
        syntheticTurn();
        replyInterim();
        spokeReply();
        reached.syntheticRetained++;
        break;
      }
      case "syntheticInterrupted": {
        const prompt = syntheticTurn();
        bargeIn(turn.heardWords, turn.steps, 0, prompt);
        // `persistBargeIn` rolls the prompt back only when the turn left no
        // trace at all — no completed steps AND nothing heard.
        if (turn.steps === 0 && turn.heardWords === 0) reached.syntheticRolledBack++;
        else reached.syntheticRetained++;
        break;
      }
      case "strandedBargeIn": {
        // The shape `TurnGate` exists for: the epoch is captured while the turn
        // is live, the reset lands, and the deferred persistence must then write
        // NOTHING into the fresh conversation.
        userTurn();
        const stale = gate.historyEpoch();
        replyInterim();
        reset();
        const heard = words(KIND.interrupted, turn.heardWords);
        outcome.persistBargeIn({
          historyEpoch: stale,
          accumulated: `${heard} tail-nobody-heard`,
          heardChars: heard.length,
          persistedLen: 0,
          stepMessages: [],
        });
        reached.strandedBargeIns++;
        break;
      }
      default: {
        // Unreachable, and the `never` binding is the point: a new `Turn` arm is
        // a COMPILE error here rather than a turn the driver silently skips,
        // which would quietly drop a shape out of every floor below.
        const unreachable: never = turn;
        throw new Error(`unknown turn ${JSON.stringify(unreachable)}`);
      }
    }
    // Two consecutive user messages — the shape `dropTrailingUser` exists to
    // prevent one flavour of, and which a failed or silently-interrupted turn
    // legitimately produces.
    const tail = history.conversation.slice(Math.max(0, before - 1));
    for (let i = 1; i < tail.length; i++) {
      if (tail[i]?.role === "user" && tail[i - 1]?.role === "user") reached.backToBackUsers++;
    }
  }

  return { live: history.conversation, replayed: messagesFromEvents(log), spoken, ledger };
}

/**
 * The boundary claim, asserted as ONE value so a divergence prints both sides.
 *
 * Both reconstructions are front-trimmed windows over the same underlying
 * stream, and they trim DIFFERENT sequences (live keeps `s`/`k` and drops
 * `e`/`f`; replay does the reverse), so past the cap the two windows reach back
 * to different depths.
 *
 * **Three sequences are compared, not two, and the third is what stops this
 * being a mirror.** `driven.ledger` is the driver's note of what the session
 * DID; both reconstructions are checked against it as well as against each
 * other, so two implementations wrong the same way cannot pass.
 *
 * `mode` is the strength of the claim rather than an optimisation. Below the cap
 * nothing has been trimmed, so all three sequences must be IDENTICAL; `windowed`
 * weakens that to "each reconstruction's tail agrees with the ledger's", which
 * is all that is true once the window has slid.
 *
 * The weakening had a HOLE, found by the mutation A/B and not by reasoning about
 * it: with a mutual-suffix comparison and no ledger, deleting
 * `messagesFromEvents`' reset clear makes the replay's sequence longer at the
 * FRONT, which a suffix comparison slices off and reports as agreement. Against
 * the ledger, which really did clear, it does not.
 */
function boundary(driven: Driven, mode: "exact" | "windowed"): Record<string, unknown> {
  const sharedLive = contentsOf(keep(driven.live, SHARED_KINDS));
  const sharedReplay = contentsOf(keep(driven.replayed, SHARED_KINDS));
  const ledger = [...driven.ledger];
  const depth = Math.min(sharedLive.length, sharedReplay.length, ledger.length);
  // `exact` does not slice AT ALL, which is the second half of the hole below:
  // slicing to the ledger's own length still hides a reconstruction that is
  // LONGER than the ledger, because the extra entries are at the front.
  const tail = (xs: readonly string[]): string[] =>
    mode === "exact" ? [...xs] : xs.slice(Math.max(0, xs.length - depth));
  return {
    // The agreement half — and against the LEDGER it is an oracle rather than a
    // consistency check (see the module doc).
    sharedTail: tail(ledger),
    sharedTailLive: tail(sharedLive),
    sharedTailReplayed: tail(sharedReplay),
    // Neither reconstruction may hold MORE shared messages than the session
    // produced — both are WINDOWS over the ledger, so this is true of correct
    // code at any cap, and it is what makes the windowed claim able to see a
    // reconstruction that kept something the session discarded.
    liveExceedsLedger: sharedLive.length > ledger.length,
    replayExceedsLedger: sharedReplay.length > ledger.length,
    // The divergence half — the ORACLE. Anything here is a leak across the
    // boundary each module's own doc draws.
    replayOnlyKindsInLive: contentsOf(keep(driven.live, REPLAY_ONLY_KINDS)),
    liveOnlyKindsInReplay: contentsOf(keep(driven.replayed, LIVE_ONLY_KINDS)),
    // The interim rule: `session-event-history.ts:16-21` forbids reading
    // `agent-transcript.updated`, and the log is full of them.
    interimsInLive: contentsOf(keep(driven.live, INTERIM_KINDS)),
    interimsInReplay: contentsOf(keep(driven.replayed, INTERIM_KINDS)),
    // Guards the classification itself: an unclassified text would silently
    // vanish from every filter above.
    unclassifiedLive: contentsOf(driven.live).filter((c) => !isClassified(c)),
    unclassifiedReplayed: contentsOf(driven.replayed).filter((c) => !isClassified(c)),
  };
}

const isClassified = (content: string): boolean => {
  const k = content.slice(0, 1);
  return (
    SHARED_KINDS.has(k) ||
    LIVE_ONLY_KINDS.has(k) ||
    REPLAY_ONLY_KINDS.has(k) ||
    INTERIM_KINDS.has(k)
  );
};

/** What `boundary` must answer: the tails agree and nothing crossed. */
function held(driven: Driven, mode: "exact" | "windowed"): Record<string, unknown> {
  const b = boundary(driven, mode);
  return {
    ...b,
    sharedTailLive: b.sharedTail,
    sharedTailReplayed: b.sharedTail,
    liveExceedsLedger: false,
    replayExceedsLedger: false,
    replayOnlyKindsInLive: [],
    liveOnlyKindsInReplay: [],
    interimsInLive: [],
    interimsInReplay: [],
    unclassifiedLive: [],
    unclassifiedReplayed: [],
  };
}

const turnArb: fc.Arbitrary<Turn> = fc.oneof(
  fc.constant<Turn>({ t: "spoke" }),
  fc.constant<Turn>({ t: "spoke" }),
  fc.constant<Turn>({ t: "failed" }),
  fc.constant<Turn>({ t: "greeting" }),
  fc.constant<Turn>({ t: "startFailure" }),
  fc.constant<Turn>({ t: "reset" }),
  fc.constant<Turn>({ t: "syntheticSpoke" }),
  fc
    .tuple(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 1 }))
    .map(([heardWords, steps]): Turn => ({ t: "syntheticInterrupted", heardWords, steps })),
  fc
    .tuple(
      fc.integer({ min: 0, max: 3 }),
      fc.integer({ min: 0, max: 1 }),
      fc.integer({ min: 0, max: 3 }),
    )
    .map(
      ([heardWords, steps, persistedWords]): Turn => ({
        t: "interrupted",
        heardWords,
        steps,
        persistedWords,
      }),
    ),
  fc.integer({ min: 0, max: 3 }).map((heardWords): Turn => ({ t: "strandedBargeIn", heardWords })),
);

/**
 * A short generated script consumed CYCLICALLY for `count` turns.
 *
 * A session runs an unbounded number of turns; generating one entry per turn
 * prints a wall of a counterexample and shrinks to nothing readable, so the
 * grammar generates the REPERTOIRE and the driver repeats it.
 */
const cycle = (script: readonly Turn[], count: number): Turn[] =>
  Array.from({ length: count }, (_, i) => script[i % script.length] as Turn);

describe("a conversation read back out of its own event log", () => {
  /**
   * Floors are set under the OBSERVED MINIMUM over 20 runs, with the range
   * beside each — never a fraction of the mean. What a driven session reaches is
   * correlated within a run rather than independent per turn, so these
   * distributions have long left tails.
   */
  const reached = noReached();

  test("diverges from the live conversation ONLY where the two modules' docs say it does", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(turnArb, { minLength: 1, maxLength: 10 }), async (script) => {
        // 40 turns of at most 2 messages each stays under the 200-message
        // window, so the shared sequences are the SAME LENGTH and the suffix
        // claim is a full ordered identity. The cap is the sibling property.
        const driven = await driveSession(cycle(script, 40), reached);
        expect(driven.live.length).toBeLessThan(DEFAULT_MAX_HISTORY);
        expect(driven.replayed.length).toBeLessThan(DEFAULT_MAX_HISTORY);
        expect(boundary(driven, "exact"), "the replay crossed the documented boundary").toEqual(
          held(driven, "exact"),
        );
        // What makes the failure-phrase row a DEFECT and not a curiosity: the
        // phrase the replay puts into history was audible. A phrase nobody heard
        // would be a harmless bookkeeping difference.
        for (const m of keep(driven.replayed, REPLAY_ONLY_KINDS)) {
          expect(driven.spoken, "a replayed failure phrase never reached TTS").toContain(m.content);
        }
      }),
      // 400, up from 120, for `syntheticRolledBack` below: CI observed 0
      // against its `> 10` floor, so the state that floor proves was never
      // reached on the machine that gates a merge. This property runs no
      // timers (52 ms/file), so its distribution is instrument-INDEPENDENT
      // and the 0 was a left-tail draw — the case more runs really fixes.
      // Measured, it took that counter's minimum from 14 to 111, for 18 ms.
      { numRuns: 400 },
    );

    // `REPLAY_FUZZ_COVERAGE=1` prints the table, the way the pipeline and S2S
    // properties do. It is how the actuals below were taken, and how the next
    // person re-takes them.
    if (process.env.REPLAY_FUZZ_COVERAGE === "1") console.log(JSON.stringify(reached));
    // Ranges over 22 runs at `numRuns: 400`. Without these the equality above
    // is satisfied by a corpus of plain spoken turns, which has no boundary in
    // it to pin. The floors are deliberately NOT raised to match their 5-18x
    // headroom: calibrating eight numbers off ten local runs is the mistake
    // that put the pipeline floor above CI's whole range.
    expect(reached.spokenTurns, "no turn ever spoke").toBeGreaterThan(800); // 4558-5029
    expect(reached.interruptedKept, "no barge-in ever recorded heard words").toBeGreaterThan(350); // 2190-2508
    expect(
      reached.interruptedSilent,
      "no barge-in left the caller hearing nothing",
    ).toBeGreaterThan(90); // 718-992
    expect(
      reached.strandedBargeIns,
      "no deferred persistence was stranded by a reset",
    ).toBeGreaterThan(240); // 1279-1855
    expect(reached.syntheticRetained, "no injected prompt survived its turn").toBeGreaterThan(520); // 2598-3092
    // The widest spread here by a factor of six — it needs BOTH no completed
    // step and nothing heard, which is one draw in eight of the shape that
    // generates it — so the floor sits well under the minimum rather than near it.
    expect(reached.syntheticRolledBack, "no injected prompt was ever rolled back").toBeGreaterThan(
      10,
    ); // 111-355
    expect(reached.errorPhrases, "no turn ever failed").toBeGreaterThan(220); // 1335-1752
    expect(reached.startFailures, "no session ever failed to start").toBeGreaterThan(210); // 1384-1792
    expect(reached.resets, "no reset ever discarded the conversation").toBeGreaterThan(600); // 3052-3578
    expect(reached.backToBackUsers, "two user turns never landed in a row").toBeGreaterThan(200); // 1310-1718
  });

  test("agrees on the TAIL when the 200-message window has slid past the difference", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(turnArb, { minLength: 1, maxLength: 8 }), async (script) => {
        // 220 turns: enough that a script of nothing but spoken turns overruns
        // the window on both sides, while a reset-heavy one may never reach it —
        // which is why the trim counters below are floored rather than asserted.
        const driven = await driveSession(cycle(script, 220), reached);
        if (driven.live.length >= DEFAULT_MAX_HISTORY) reached.liveTrims++;
        if (driven.replayed.length >= DEFAULT_MAX_HISTORY) reached.replayTrims++;
        expect(driven.live.length).toBeLessThanOrEqual(DEFAULT_MAX_HISTORY);
        expect(driven.replayed.length).toBeLessThanOrEqual(DEFAULT_MAX_HISTORY);
        expect(boundary(driven, "windowed"), "the replay crossed the documented boundary").toEqual(
          held(driven, "windowed"),
        );
      }),
      { numRuns: 40 },
    );

    if (process.env.REPLAY_FUZZ_COVERAGE === "1") console.log(JSON.stringify(reached));
    // Ranges over 20 runs. Two counters and not one: the two sides trim
    // DIFFERENT sequences, so a corpus that fills the live window is not a
    // corpus that fills the replay's — the replay drops every `[interrupted]`
    // reply and every injected prompt, and gains only a failure phrase per
    // failed turn, so it is the side that lags. Re-taken over 6 runs after the
    // rollback fix above (12-22 / 8-16): both floors stand rather than move.
    expect(reached.liveTrims, "the live window never filled").toBeGreaterThan(5); // 10-21
    expect(reached.replayTrims, "the replayed window never filled").toBeGreaterThan(5); // 10-23
  });
});
