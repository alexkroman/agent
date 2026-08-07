// Copyright 2026 the AAI authors. MIT license.
/**
 * Randomized interleaving fuzz over the pipeline transport.
 *
 * The scripted specs in `host/transports/` each assert ONE interleaving. This
 * suite drives the transport through random sequences of the events a real
 * session produces — STT partials/finals, TTS audio, client cancels, resets,
 * barge-ins landing inside a tool execution — and checks GLOBAL invariants
 * instead of specific outcomes, so it covers orderings nobody wrote a spec for.
 *
 * It needs no API keys (the fakes in `host/_pipeline-test-fakes.ts` stand in for
 * every provider); it lives in the integration tier only because it is too slow
 * for the 5s unit budget.
 *
 * Three things to know before changing it:
 *
 * - **Every oracle must be a property a real provider or client enforces.** The
 *   strongest one here validates each LLM request payload the way Anthropic and
 *   OpenAI do (`promptProblems`): a `tool` result with no matching `tool-call`
 *   is a hard 400. That oracle is what surfaced the history-cap bug fixed in
 *   `pipeline-history.ts` (`capLlm`), which is why `LONG_SEEDS` exists — those
 *   are the only seeds that push past `DEFAULT_MAX_HISTORY` and make the cap
 *   trim at all.
 * - **The REGRESSION guard for that bug is the deterministic spec in
 *   `transports/pipeline-history.test.ts`**, not this suite. Whether a trim
 *   splits a tool pair depends on the window's alignment with turn boundaries,
 *   so a random walk reaches it only sometimes. Discovery and regression are
 *   different jobs; do not delete that spec on the grounds that this one covers
 *   the same ground.
 * - **The generator must not itself break a provider contract.** An earlier
 *   draft emitted TTS audio at arbitrary moments and the truncation oracle duly
 *   fired — on the generator, not the transport. A fake that does something no
 *   real provider does produces findings that cost real time to dismiss.
 *
 * Finally: an all-green fuzz proves nothing if it never reached the interesting
 * state. The coverage floors at the bottom fail the suite when the random walk
 * stops visiting barge-in, tool execution, history trimming, or reply
 * completion — a greener result than last run is usually a broken generator
 * rather than a fixed bug. fast-check has no equivalent (`fc.statistics` only
 * prints), so those stay hand-rolled and accumulate across runs.
 *
 * ## What fast-check generates
 *
 * Everything a seeded PRNG used to decide, as one structured value per run, so a
 * failure shrinks instead of reporting a seed: the step script (action + the
 * utterance opener + the pause after it), the LLM script pattern (which turns
 * call a tool), each tool call's behaviour, and `preemptiveGeneration`. The
 * middle two are SHORT lists consumed cyclically rather than one entry per
 * possible call — a run may consume thousands of script steps, and generating
 * that many would print a wall of a counterexample and shrink to nothing
 * readable.
 *
 * ## The `preemptiveGeneration` arm
 *
 * The flag is generated rather than pinned off, so both arms run in one
 * property and a counterexample names which one it came from. Two things move
 * with it, and both are honest limits rather than tidiness:
 *
 * - The exact-text reply-integrity oracle is SKIPPED in the ON arm, because a
 *   speculation's generated text cannot be attributed to a reply at the moment
 *   it is served. See `checkReplyIntegrity` for the full reasoning; the adopted
 *   reply's text is pinned deterministically in
 *   `transports/pipeline-preemption.test.ts` instead.
 * - The turn-serialization bound widens by the speculation budget, because a
 *   speculation is deliberately outside the turn chain.
 *
 * What the arm ADDS is guardrail 1 as a global property — nothing may reach TTS
 * between a cleanly completed reply and the next `onReplyStarted`, which is
 * exactly the idle window a speculation runs in.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { MAX_PREEMPTIVE_SPECULATIONS_PER_UTTERANCE } from "../../sdk/constants.ts";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
  type FakeSttProvider,
  type FakeTtsProvider,
} from "../_pipeline-test-fakes.ts";
import { sleep } from "../_test-utils.ts";
import type { Logger } from "../runtime-config.ts";
import { createPipelineTransport } from "../transports/pipeline-transport.ts";
import {
  type ActionKind,
  buildScript,
  type FuzzStep,
  OPENERS,
  type RunInput,
  scriptPatternArb,
  shortRunArb,
  stepPauseMs,
  type ToolBehavior,
} from "./_pipeline-fuzz-input.ts";
import { createCallbacks, GREETING, instrumentLlm, type Monitor } from "./_pipeline-fuzz-model.ts";

/** Runs of the short session property (structural + integrity invariants). */
const SHORT_RUNS = 120;
/** Runs long enough to push the LLM history past DEFAULT_MAX_HISTORY. */
const LONG_RUNS = 3;
/** Steps per long run — enough turns to trim at the cap. */
const LONG_STEPS = 200;

const noop = (): void => undefined;
const silentLogger: Logger = { info: noop, warn: noop, error: noop, debug: noop };

type Coverage = Record<string, number>;

interface SeedOptions {
  /** Commit turns steadily and never reset, so history reaches the cap. */
  longSession?: boolean;
  /** Prior history length — shifts where the cap's trim boundary falls. */
  seedHistory?: number;
}

/**
 * The events a generated step can fire, keyed by action.
 *
 * `reset` is a no-op in a long session: it clears history, so a long run that
 * reset could never reach the cap its runs exist to exercise.
 */
function buildActions(
  mon: Monitor,
  deps: {
    stt: FakeSttProvider;
    tts: FakeTtsProvider;
    transport: ReturnType<typeof createPipelineTransport>;
    utterance: (opener: number) => string;
    longSession: boolean;
    armBargeInFromTool: () => void;
    /**
     * The text a `highConfidencePartial` last spoke, so the NEXT `sttFinal`
     * commits the same words. Without it every final revises its partial and the
     * match rule discards 100% of speculations — the adoption path would be
     * generated and never entered.
     */
    speculated: { text: string | null };
    /** Does the step being dispatched pause afterwards? See highConfidencePartial. */
    lastPauseWasNull(): boolean;
  },
): Record<ActionKind, (opener: number) => void> {
  const { stt, tts, transport, utterance, speculated, lastPauseWasNull } = deps;
  return {
    sttPartial: (opener) => stt.last()?.firePartial(utterance(opener)),
    sttFinal: (opener) => {
      const text = speculated.text ?? utterance(opener);
      speculated.text = null;
      stt.last()?.fireFinal(text);
    },
    // A confident interim — what a real STT emits as an utterance completes
    // (`SttTurnMeta.endOfTurnConfidence`); 1 clears the threshold however it is
    // retuned. Biased toward the speculating state the way `armBargeInFromTool`
    // is biased toward a barge-in inside a tool call, and everything it fires is
    // something a real session does.
    //
    // The two shapes it has to reach are opposite, so the step's OWN generated
    // pause chooses between them — no extra field, and it reads the way the
    // audio does. No pause at all means the caller stopped dead on that word, so
    // the final lands with it and the speculation is ADOPTED (zero head start,
    // which is the harder path: the tape is claimed before its request has even
    // been issued). A pause means the utterance is still open, so the text is
    // handed to the next `sttFinal` and the speculation has to survive whatever
    // the walk does in between — usually nothing, because at this suite's 1 ms
    // `speechIdleTimeoutMs` the watchdog reaps it, which is the DISCARD side.
    highConfidencePartial: (opener) => {
      const text = utterance(opener);
      stt.last()?.firePartial(text, { endOfTurnConfidence: 1 });
      if (lastPauseWasNull()) stt.last()?.fireFinal(text);
      else speculated.text = text;
    },
    ttsAudio: () => {
      // A real TTS provider emits audio only while a turn's synthesis is in
      // flight, never after signalling `done` for it (TtsEvents in
      // sdk/providers.ts). Outside that window this would trip the truncation
      // oracle on the generator's own contract violation.
      if (mon.current === null || mon.current.done) {
        mon.hit("audioSuppressedOutsideTurn");
        return;
      }
      tts.last()?.fireAudio(new Int16Array(2400));
    },
    cancelReply: () => {
      mon.disturb();
      transport.cancelReply();
    },
    reset: () => {
      if (deps.longSession) return;
      mon.disturb();
      // Optional on Transport (S2S has no conversation state of its own).
      transport.reset?.();
    },
    sendUserAudio: () => transport.sendUserAudio(new Uint8Array(320)),
    armBargeInFromTool: () => deps.armBargeInFromTool(),
    // Bias toward FALSE-INTERRUPTION RECOVERY, the way `armBargeInFromTool`
    // biases toward a barge-in inside a tool call. A uniform walk reaches it
    // almost never: the shape needs a partial to land while the agent is
    // AUDIBLY speaking (measured: 8 such barge-ins in a whole property run,
    // of which 1 resumed), then a quiet transcript stream with no final ever
    // arriving. This composes it — audio for the live turn, then a noise
    // partial — and `runOne`'s step loop supplies the quiet gap. Every part of
    // it is something a real session does; nothing here is illegal for a
    // provider to emit.
    noiseBargeIn: () => {
      // Same contract as `ttsAudio`: a real provider emits no audio outside a
      // turn's synthesis window.
      if (mon.current !== null && !mon.current.done) tts.last()?.fireAudio(new Int16Array(2400));
      stt.last()?.firePartial("uh what");
    },
  };
}

let runCounter = 0;

async function runOne(
  input: RunInput,
  stepCount: number,
  cov: Coverage,
  seedOpts: SeedOptions = {},
): Promise<string[]> {
  const longSession = seedOpts.longSession === true;
  // Only used to keep tool-call ids unique across runs in one process.
  const runId = String(++runCounter);
  const violations: string[] = [];
  let step = 0;
  /** The pause the step being dispatched will take afterwards, or null. */
  let currentPause: number | null = null;

  const mon: Monitor = {
    current: null,
    stopped: false,
    declaredDead: null,
    toolInFlight: 0,
    audioTotal: 0,
    liveStreams: 0,
    maxLiveStreams: 0,
    consumedSteps: 0,
    speculating: input.preemptiveGeneration,
    ttsAccountedFor: 0,
    flag: (what) => violations.push(`step ${step}: ${what}`),
    hit: (key) => {
      cov[key] = (cov[key] ?? 0) + 1;
    },
    disturb: () => {
      const reply = mon.current;
      if (reply === null || reply.done) return;
      reply.disturbed = true;
      // Cut with nothing audible ever forwarded for it: the heard cursor's
      // zero case, where history must record none of what the model produced.
      // Counted here rather than at `onCancelled` because a barge-in requires
      // audible speech by definition — the reachable zero cases are the client
      // cancel and the reset.
      // Only counted when the model actually produced words — those are the
      // replies whose record the new rule changes.
      if (reply.audioChunks === 0 && reply.expected.length > 0) {
        mon.hit("interruptedWithNothingHeard");
      }
    },
  };

  const stt: FakeSttProvider = createFakeSttProvider();
  const tts: FakeTtsProvider = createFakeTtsProvider();
  const { steps: script, stepText } = buildScript(input.script, runId);
  const llm = createFakeLanguageModel({ steps: script, delayMs: 1 });
  instrumentLlm(llm, stepText, mon, input.refusals);

  // Bias toward the rare state a uniform random walk barely reaches: a barge-in
  // landing INSIDE a tool execution.
  let bargeInFromTool = false;
  let toolCallIndex = 0;
  const executeTool = async (): Promise<string> => {
    mon.hit("toolExecuted");
    mon.toolInFlight++;
    try {
      if (bargeInFromTool) {
        bargeInFromTool = false;
        mon.hit("bargeInFromInsideTool");
        stt.last()?.firePartial("no wait stop that please");
      }
      const behavior = input.tools[toolCallIndex++ % input.tools.length] as ToolBehavior;
      if (behavior.kind === "throw") throw new Error("tool blew up");
      if (behavior.kind === "slow") await sleep(behavior.ms);
      return "tool result";
    } finally {
      mon.toolInFlight--;
    }
  };

  const seededHistory = Array.from({ length: seedOpts.seedHistory ?? 0 }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `earlier turn ${i}`,
  }));

  const transport = createPipelineTransport({
    sid: `fuzz-${runId}`,
    stt,
    llm,
    tts,
    callbacks: createCallbacks(mon, tts),
    sessionConfig: {
      systemPrompt: "s",
      greeting: GREETING,
      ...(seededHistory.length > 0 ? { history: seededHistory } : {}),
    },
    executeTool,
    providerKeys: { stt: "stt-key", tts: "tts-key" },
    toolSchemas: [
      {
        type: "function",
        name: "lookup",
        description: "Look something up.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    ],
    // Counts the false-interruption outcomes and every speculation off the
    // transport's own log lines — none of them has a callback, and the
    // speculation ones are the very instrument the flag's doc names as what
    // would justify flipping the default, so reading them here also pins that
    // they are emitted at all.
    logger: {
      ...silentLogger,
      info: (msg: string) => {
        if (msg === "Pipeline false-interruption resume") mon.hit("falseInterruptionResumed");
        else if (msg === "Pipeline resume mooted by committed user turn") mon.hit("resumeMooted");
        else if (msg === "Pipeline speculation adopted") mon.hit("speculationAdopted");
      },
      debug: (msg: string, meta?: unknown) => {
        if (msg === "Pipeline speculation started") {
          mon.hit("speculationStarted");
          // BOUNDED PER UTTERANCE, read straight off the start log's running
          // total. **This suite is NOT the guard for that rule** — say so rather
          // than let the next reader assume it. Deleting the budget check from
          // `mayFire` leaves this suite entirely green, measured, because two
          // other conditions bind first: only one speculation is ever HELD (a
          // new partial supersedes the last), and at this harness's 1 ms
          // `speechIdleTimeoutMs` the utterance ends — restoring the budget —
          // long before a third could fire. So the concurrency bound above does
          // not enforce the budget and neither does this. The rule is pinned
          // deterministically in `transports/pipeline-speculation.test.ts`
          // ("bounded per utterance however the confidence sawtooths"); this
          // stays as a cheap net for an interleaving that does reach it.
          const spent = (meta as { spent?: number } | undefined)?.spent ?? 0;
          if (spent > MAX_PREEMPTIVE_SPECULATIONS_PER_UTTERANCE) {
            mon.flag(`speculation ${spent} of one utterance exceeds the per-utterance budget`);
          }
        } else if (msg === "Pipeline speculation discarded") {
          mon.hit("speculationDiscarded");
          const reason = (meta as { reason?: string } | undefined)?.reason;
          if (reason !== undefined) mon.hit(`speculationDiscarded:${reason}`);
        }
      },
    },
    preemptiveGeneration: input.preemptiveGeneration,
    // Zero: a run lasts ~250 ms of wall clock, so at the shipped lag every
    // reply is the heard-nothing case. PARTIAL truncation is deliberately NOT
    // covered here for the same reason (the heard position is always near
    // zero, so a floor on it would flake) —
    // `pipeline-transport-barge-in.test.ts` owns that case.
    heardLagMs: 0,
    resumeFalseInterruption: true,
    // The resume deadline. It has to be set: the resume fires when the
    // speaking edge goes idle, the shipped deadline is 3500 ms, and a run here
    // lasts ~250 ms — so at the default the resume state is UNREACHABLE and
    // the counters below would floor at zero. (This is also why the old
    // `falseInterruptionTimeoutMs: 3` was decorative: that knob never governed
    // the wait.)
    speechIdleTimeoutMs: 1,
    silenceTimeoutMs: 5,
    interruptionMinDurationMs: 0,
    // Disabled so the reply-integrity oracle is exact: with filler enabled,
    // text reaching TTS that the model never produced is legitimate. Worth
    // recording that this is why the fuzz could never have caught the
    // holdPhrase/dead-air coupling defect — it runs with cover off.
    deadAirCoverMs: 0,
    errorPhrase: "",
  });

  await transport.start();

  let seq = 0;
  const utterance = (opener: number): string => {
    seq++;
    return `${OPENERS[opener % OPENERS.length] as string} number ${seq}`;
  };

  const actions = buildActions(mon, {
    stt,
    tts,
    transport,
    utterance,
    longSession,
    armBargeInFromTool: () => {
      bargeInFromTool = true;
    },
    speculated: { text: null },
    lastPauseWasNull: () => currentPause === null,
  });

  // One in-flight TURN, plus — with preemption on — a ceiling for the
  // speculations that can be open alongside it. This oracle is about the TURN
  // CHAIN, and a speculation is deliberately outside it (it occupies no turn
  // precisely so it cannot block the turn it exists to accelerate), so a second
  // concurrent request is legal in that arm rather than a serialization break.
  // The per-utterance BUDGET is not what this checks, and neither is the `spent`
  // oracle on the logger below — both stay green with the budget check deleted
  // (measured). `transports/pipeline-speculation.test.ts` owns that rule.
  const maxConcurrentStreams = input.preemptiveGeneration
    ? 1 + MAX_PREEMPTIVE_SPECULATIONS_PER_UTTERANCE
    : 1;
  const checkSerialization = (): void => {
    if (mon.maxLiveStreams > maxConcurrentStreams) {
      mon.flag(
        `${mon.maxLiveStreams} LLM streams open at once — more than one turn ` +
          `plus ${maxConcurrentStreams - 1} speculation(s)`,
      );
      mon.maxLiveStreams = maxConcurrentStreams;
    }
  };

  const checkClosedSessionWrites = (before: { stt: number; tts: number }): void => {
    const sttSession = stt.last();
    const ttsSession = tts.last();
    if (sttSession?.closed.value === true && sttSession.audioFrames.length > before.stt) {
      mon.flag("sendAudio reached a closed STT session");
    }
    if (ttsSession?.closed.value === true && ttsSession.textChunks.length > before.tts) {
      mon.flag("sendText reached a closed TTS session");
    }
  };

  for (step = 0; step < stepCount; step++) {
    if (longSession) {
      // Plain back-to-back turns: the point is to accumulate history, and a
      // random walk spends most steps on events that commit no turn.
      stt.last()?.fireFinal(utterance(step));
      await sleep(4);
      checkSerialization();
      continue;
    }
    const before = {
      stt: stt.last()?.audioFrames.length ?? 0,
      tts: tts.last()?.textChunks.length ?? 0,
    };
    const fuzzStep = input.steps[step % input.steps.length] as FuzzStep;
    const pauseMs = stepPauseMs(fuzzStep);
    currentPause = pauseMs;
    actions[fuzzStep.action](fuzzStep.opener);
    if (pauseMs !== null) {
      await sleep(pauseMs);
    }
    checkClosedSessionWrites(before);
    checkSerialization();
  }

  const outcome = await Promise.race([
    transport.stop().then(() => "stopped" as const),
    new Promise<"hung">((r) => setTimeout(() => r("hung"), 5000)),
  ]);
  if (outcome === "hung") mon.flag("stop() did not resolve within 5s");
  mon.stopped = true;
  await sleep(30);

  if (stt.last()?.closed.value !== true) mon.flag("STT session left open after stop()");
  if (tts.last()?.closed.value !== true) mon.flag("TTS session left open after stop()");

  return violations;
}

/**
 * Shared across every run of a property: coverage accumulates (a floor is about
 * the whole run, not one interleaving) and unhandled rejections are collected
 * process-wide, since the rejection that matters is usually one no run awaited.
 */
type Harness = {
  cov: Coverage;
  unhandled: string[];
  dispose(): void;
};

function installHarness(): Harness {
  const unhandled: string[] = [];
  const onUnhandled = (e: unknown): void => {
    unhandled.push(String(e));
  };
  process.on("unhandledRejection", onUnhandled);
  return {
    cov: {},
    unhandled,
    dispose: () => process.off("unhandledRejection", onUnhandled),
  };
}

// Split into two tests rather than one: each gets its own timeout budget, and
// the integration profile allows 30s. One combined run measured ~10s locally,
// which a loaded shared runner can stretch past the limit.
describe("pipeline transport — randomized interleaving", () => {
  test("global invariants hold across random event orderings", async () => {
    const harness = installHarness();
    try {
      await fc.assert(
        fc.asyncProperty(shortRunArb, async (input) => {
          const violations = await runOne(input, input.steps.length, harness.cov);
          // Sliced: a systemic break should report a readable sample, not
          // hundreds of lines of the same thing.
          expect(violations.slice(0, 8)).toEqual([]);
        }),
        { numRuns: SHORT_RUNS },
      );
      expect(harness.unhandled).toEqual([]);
    } finally {
      harness.dispose();
    }

    // Coverage floors — see the module doc. Set roughly 3x below the lowest of
    // four measured runs (actuals noted alongside) because these vary more than
    // they used to: the old harness ran a FIXED seed list, so its counts were
    // near-constant, while fast-check draws a fresh seed per CI run and the step
    // count is itself generated. That is the trade — new interleavings every run
    // in exchange for looser floors — and it is the right one, because a floor
    // is here to catch a generator that stopped reaching a state, never to pin a
    // count.
    const { cov } = harness;
    // `PIPELINE_FUZZ_COVERAGE=1` prints the whole table, the way
    // `S2S_FUZZ_COVERAGE=1` does for the S2S property. It is how the actuals
    // quoted below were taken, and how the next person re-takes them.
    if (process.env.PIPELINE_FUZZ_COVERAGE === "1") console.log(JSON.stringify(cov, null, 2));
    // One reader for the counters: a `?? 0` at every call site is most of this
    // function's cognitive-complexity budget.
    const count = (key: string): number => cov[key] ?? 0;
    expect(count("replyStarted"), "no reply ever started").toBeGreaterThan(120); // ~350
    expect(count("replyDone"), "no reply ever completed").toBeGreaterThan(25); // ~95
    // LOWERED from 25 when `preemptiveGeneration` joined the generated world,
    // and this is the one floor in the file that has ever moved DOWN. Roughly
    // half the runs now have the flag on, and those runs skip the exact-text
    // check entirely (see checkReplyIntegrity), so the same generator that
    // measured ~95 now measures 30-50 over five runs. The floor is 3x below that
    // minimum, on the same rule as every other one here.
    expect(count("replyIntegrityChecked"), "reply text never checked").toBeGreaterThan(10); // 30-50
    expect(count("toolExecuted"), "no tool ever ran").toBeGreaterThan(18); // ~62
    expect(count("llmRequestWithTool"), "no request carried a tool result").toBeGreaterThan(18); // ~65
    expect(count("bargeInFromInsideTool"), "never barged in during a tool").toBeGreaterThan(12); // ~35
    // Barge-in needs the turn to have SPOKEN, so this is the most
    // timing-sensitive counter of the set.
    expect(count("cancelled"), "no reply was ever cancelled").toBeGreaterThan(7); // ~33
    // Both ways a turn's LLM can fail, because they are separate reporters: an
    // `error` stream part, and a request that never streams at all. Each keeps
    // the fatality oracle in `createCallbacks` reachable — it passed on arrival
    // precisely because nothing here could fail a turn.
    expect(count("error:llm"), "no turn's LLM stream ever failed").toBeGreaterThan(8);
    expect(count("llmRefused"), "no LLM request was ever refused").toBeGreaterThan(2);
    // And every one of them was reported NON-fatally, so a regression to the
    // `onError` default is a failure here rather than a silent gap.
    expect(count("nonFatal:llm")).toBe(count("error:llm"));
    // False-interruption recovery. Both states were unreachable here until the
    // resume deadline was shortened (see `speechIdleTimeoutMs` in runOne), so
    // an all-green run said nothing about resumes at all. The mooted one is
    // the more interesting oracle — it is where `dropTrailingUser`, the
    // unspoken-turn abort and the turn gate meet — and it is much rarer, so it
    // gets the lower floor rather than a generator nudge.
    // False-interruption recovery, which this suite could not reach at all
    // until the `noiseBargeIn` action and the short `speechIdleTimeoutMs` in
    // `runOne`: the resume fires when the speaking edge goes idle, the shipped
    // deadline is 3500 ms, and a run here lasts ~250 ms. Measured over six
    // runs: partial barge-ins 51-71 (8 before the nudge), resumes 10-31 (0-1
    // before it).
    expect(count("falseInterruptionResumed"), "no reply was ever resumed").toBeGreaterThan(3);
    // The heard cursor's zero case — a reply that produced words and forwarded
    // no audio, so history records none of it. Keeps `checkPrompt`'s
    // no-audio-no-record oracle reachable.
    expect(count("interruptedWithNothingHeard"), "nothing was cut pre-audio").toBeGreaterThan(60); // ~192-243
    // `resumeMooted` — a committed final killing a still-silent resume turn —
    // is DELIBERATELY counted but NOT floored. It is the more interesting
    // oracle (dropTrailingUser, the unspoken-turn abort and the turn gate all
    // meet there), and it is reached: 1-8 times per run over the same six runs.
    // But its window is the resume turn's time-to-first-audio, ~1 ms with this
    // fake LLM, so a floor even at 1 would flake, and widening it means
    // distorting the generator for one counter. `pipeline-voice-events.test.ts`
    // pins the behaviour deterministically instead. What it CAN carry is an
    // invariant rather than a floor: a resume can only be mooted if one fired,
    // and each fired resume can be mooted at most once.
    expect(count("resumeMooted")).toBeLessThanOrEqual(count("falseInterruptionResumed"));

    // PREEMPTIVE GENERATION. The flag is generated, so roughly half the runs
    // carry it and these counters come off the transport's own log lines — the
    // same lines the feature's doc names as the instrument that would justify
    // flipping the default, so flooring them also pins that they are emitted.
    // Measured over five runs: started 41-68, discarded 38-65.
    expect(count("speculationStarted"), "no speculation ever started").toBeGreaterThan(13);
    expect(count("speculationDiscarded"), "no speculation was ever discarded").toBeGreaterThan(12);
    // The two rules the recorded confidence sawtooth dictated, each floored on
    // its own so a policy that stopped applying one is a failure rather than a
    // shift in the totals. Measured: superseded 5-10, mismatch 6-13.
    expect(count("speculationDiscarded:superseded"), "no partial ever revised").toBeGreaterThan(1);
    expect(count("speculationDiscarded:mismatch"), "no final ever mismatched").toBeGreaterThan(1);
    // ADOPTION is counted and DELIBERATELY NOT floored, on the `resumeMooted`
    // precedent above. It needs the transport IDLE at the instant a confident
    // interim lands, and this harness is busy by construction — a 5 ms
    // `silenceTimeoutMs` keeps nudge turns running and the generator keeps audio
    // playing out — so it lands 0-6 times per run over five runs, and a floor
    // even at 1 would flake. Widening it means distorting the generator for one
    // counter. `transports/pipeline-preemption.test.ts` pins adoption
    // deterministically instead. What this CAN carry is the accounting
    // invariant: every speculation is claimed at most once, either way.
    expect(count("speculationAdopted") + count("speculationDiscarded")).toBeLessThanOrEqual(
      count("speculationStarted"),
    );
  }, 60_000);

  test("global invariants hold across a long session past the history cap", async () => {
    const harness = installHarness();
    try {
      await fc.assert(
        fc.asyncProperty(
          scriptPatternArb,
          // Prior history length varies the starting alignment: whether a trim
          // splits a tool pair depends on where the window boundary falls
          // inside a turn.
          fc.nat({ max: 3 }),
          async (script, seedHistory) => {
            const violations = await runOne(
              // Never refused: this property's job is to accumulate history past
              // the cap, and a refused request contributes no turn to it. The
              // `fail` turns the shared pattern can carry are fine — they commit
              // the user's side and exercise the fatality oracle here too.
              // Preemption off: this property fires only finals, so nothing
              // would ever speculate, and leaving it off keeps the exact-text
              // integrity oracle live here (see checkReplyIntegrity).
              {
                steps: [],
                script,
                tools: [{ kind: "ok" }],
                refusals: [false],
                preemptiveGeneration: false,
              },
              LONG_STEPS,
              harness.cov,
              { longSession: true, seedHistory },
            );
            expect(violations.slice(0, 8)).toEqual([]);
          },
        ),
        { numRuns: LONG_RUNS },
      );
      expect(harness.unhandled).toEqual([]);
    } finally {
      harness.dispose();
    }

    // The state this property exists for: past DEFAULT_MAX_HISTORY the cap
    // trims on every push, which is what can orphan a tool result.
    expect(
      harness.cov.llmRequestAtHistoryCap ?? 0,
      "never reached the history cap",
    ).toBeGreaterThan(10);
  }, 60_000);
});
