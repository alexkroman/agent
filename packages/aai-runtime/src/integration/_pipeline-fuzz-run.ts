// Copyright 2026 the AAI authors. MIT license.
/**
 * One RUN of the pipeline-transport property test: build the transport over the
 * fakes, walk the generated steps against it, tear it down, and hand back the
 * violations the monitor collected. Also the shared run counts, which live with
 * the runner because they are what its cost is measured in.
 *
 * Fourth member of the `_pipeline-fuzz-*` family — see
 * `_pipeline-fuzz-actions.ts` for the split and where each piece lives. The
 * coverage FLOORS deliberately stay with the properties that read them, in the
 * `.integration.test.ts` file, since a floor is a claim about one property's
 * generator rather than about this runner.
 */

import { MAX_PREEMPTIVE_SPECULATIONS_PER_UTTERANCE } from "@alexkroman1/aai/host-internal";
import { errorMessage } from "@alexkroman1/aai/utils";
import pTimeout, { TimeoutError } from "p-timeout";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
  type FakeSttProvider,
  type FakeTtsProvider,
} from "../_pipeline-test-fakes.ts";
import { sleep } from "../_test-utils.ts";
import { silentLogger } from "../runtime-config.ts";
import { createPipelineTransport } from "../transports/pipeline-transport.ts";
import { buildActions } from "./_pipeline-fuzz-actions.ts";
import {
  buildScript,
  type FuzzStep,
  OPENERS,
  type RunInput,
  stepPauseMs,
  type ToolBehavior,
} from "./_pipeline-fuzz-input.ts";
import { createCallbacks, GREETING, instrumentLlm, type Monitor } from "./_pipeline-fuzz-model.ts";

/** How long a run's `stop()` may take before it counts as hung. */
const STOP_DEADLINE_MS = 5000;

/** Runs of the short session property (structural + integrity invariants). */
export const SHORT_RUNS = 120;
/**
 * Runs long enough to push the LLM history past DEFAULT_MAX_HISTORY.
 *
 * Raised from 3 after `llmRequestAtHistoryCap` (this property's only floor,
 * `> 10`) was seen to MISS on a clean tree. Three runs is too few for a
 * counter this variable: measured over four fresh runs at 3 it came in at
 * 34 / 50 / 108 / 56 — a 3x spread — so the floor sat nominally 3x below the
 * observed minimum and still inside the left tail. Same remedy the S2S
 * property's header prescribes and for the same reason: move the
 * DISTRIBUTION right rather than the floor down, since a lower floor buys
 * quiet by proving less. At 6 the same four-run measurement reads
 * 30 / 52 / 96 / 147, and the file costs ~10s more.
 *
 * The spread is driven by `scriptPatternArb` (how many turns a run commits),
 * not by the run count, so doubling widens the sample without narrowing the
 * ratio much. If it misses again, raise this rather than the floor — and if
 * that stops helping, the generator is what needs the nudge.
 *
 * **That last sentence has one documented exception, and it already fired.**
 * Raising this answers a LEFT-TAIL draw on one instrument. It does not answer a
 * shifted DISTRIBUTION across instruments, which is what `llmRequestAtHistoryCap`
 * turned out to have: 199-425 locally against 44-68 in CI, because the config
 * this file installs is tuned to "a run lasts ~250 ms" of REAL time and a
 * 2-core runner does not honour that. Covering a 4x shift needs ~3x the runs on
 * a property already at 5.9 s under a 60 s timeout, so that floor was moved
 * under CI's own minimum instead — the reasoning is at the assertion, in
 * `pipeline-fuzz.integration.test.ts`. Before raising this again, check WHICH
 * of the two you are looking at: if local and CI disagree, more runs is the
 * expensive way to not fix it.
 */
export const LONG_RUNS = 6;
/** Steps per long run — enough turns to trim at the cap. */
export const LONG_STEPS = 200;

type Coverage = Record<string, number>;

interface SeedOptions {
  /** Commit turns steadily and never reset, so history reaches the cap. */
  longSession?: boolean;
  /** Prior history length — shifts where the cap's trim boundary falls. */
  seedHistory?: number;
}
/**
 * End the run and check what it left behind.
 *
 * Called from a `finally`, which is the point: an action or an oracle that
 * THROWS mid-walk used to skip `stop()` entirely and leave that run's
 * transport, STT and TTS sessions live for the whole of shrinking — dozens of
 * leaked sessions racing the re-runs, which is the leak the root guide names as
 * converging the shrinker on the wrong counterexample. Nothing here throws, for
 * the same reason: a failing teardown must not mask the oracle hit that is the
 * actual finding.
 *
 * `pTimeout`, not a hand-rolled race (`guard-invariants` rule 3): the losing
 * `setTimeout` was never cleared, so every generated run left a pending 5s
 * timer behind it.
 */
async function stopAndCheckTeardown(
  transport: ReturnType<typeof createPipelineTransport>,
  mon: Monitor,
  stt: FakeSttProvider,
  tts: FakeTtsProvider,
): Promise<void> {
  try {
    await pTimeout(transport.stop(), { milliseconds: STOP_DEADLINE_MS });
  } catch (err) {
    mon.flag(
      err instanceof TimeoutError
        ? `stop() did not resolve within ${STOP_DEADLINE_MS}ms`
        : `stop() threw: ${errorMessage(err)}`,
    );
  }
  mon.stopped = true;
  await sleep(30);
  if (stt.last()?.closed.value !== true) mon.flag("STT session left open after stop()");
  if (tts.last()?.closed.value !== true) mon.flag("TTS session left open after stop()");
}

let runCounter = 0;

export async function runOne(
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

  try {
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
  } finally {
    // Teardown in a `finally`, never on the happy path only — see
    // {@link stopAndCheckTeardown}.
    await stopAndCheckTeardown(transport, mon, stt, tts);
  }

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

export function installHarness(): Harness {
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
