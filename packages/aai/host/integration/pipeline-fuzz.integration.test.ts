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
 * call a tool), and each tool call's behaviour. The last two are SHORT lists
 * consumed cyclically rather than one entry per possible call — a run may
 * consume thousands of script steps, and generating that many would print a wall
 * of a counterexample and shrink to nothing readable.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
  type FakeSttProvider,
  type FakeTtsProvider,
  type ScriptedPart,
} from "../_pipeline-test-fakes.ts";
import type { Logger } from "../runtime-config.ts";
import { createPipelineTransport } from "../transports/pipeline-transport.ts";
import type { TransportCallbacks } from "../transports/types.ts";
import {
  type ActionKind,
  type FuzzStep,
  OPENERS,
  type RunInput,
  SCRIPT_LENGTH,
  type ScriptTurn,
  scriptPatternArb,
  shortRunArb,
  type ToolBehavior,
} from "./_pipeline-fuzz-input.ts";
import {
  norm,
  type PromptMsg,
  promptProblems,
  trackStreamLifetime,
} from "./_pipeline-fuzz-model.ts";

/** Runs of the short session property (structural + integrity invariants). */
const SHORT_RUNS = 120;
/** Runs long enough to push the LLM history past DEFAULT_MAX_HISTORY. */
const LONG_RUNS = 3;
/** Steps per long run — enough turns to trim at the cap. */
const LONG_STEPS = 200;

const noop = (): void => undefined;
const silentLogger: Logger = { info: noop, warn: noop, error: noop, debug: noop };
const GREETING = "hello there friend";

type Coverage = Record<string, number>;

/** Per-reply record backing the integrity and truncation oracles. */
interface ReplyRecord {
  id: string;
  /** `tts.textChunks` length when this reply started. */
  ttsOffset: number;
  /** Text the model produced for it, accumulated per consumed script step. */
  expected: string;
  /** An abort touched it, so its text may legitimately be short. */
  disturbed: boolean;
  /** Its LLM stream reported a failure. */
  failed: boolean;
  done: boolean;
}

/** Mutable state the oracles and the generator share. */
interface Monitor {
  current: ReplyRecord | null;
  stopped: boolean;
  /**
   * The session was reported DEAD to the client: an `onError` without
   * `fatal: false`. aai-ui answers that by calling `cleanupAudio()`, bumping the
   * connection generation and setting `running: false` — the microphone is
   * RELEASED and the call ends — so nothing conversational may follow it.
   */
  declaredDead: string | null;
  toolInFlight: number;
  liveStreams: number;
  maxLiveStreams: number;
  consumedSteps: number;
  flag: (what: string) => void;
  hit: (key: string) => void;
  /** Mark the in-flight reply as disturbed (an abort is about to touch it). */
  disturb: () => void;
}

/**
 * Build the LLM script: text-only turns interleaved with tool-call turns.
 *
 * `pattern` says which script steps call a tool and is CYCLED — a run can
 * consume any number of steps, so the generated pattern is short enough to read
 * in a counterexample rather than one entry per step.
 */
function buildScript(
  pattern: readonly ScriptTurn[],
  runId: string,
): { steps: ScriptedPart[][]; stepText: string[] } {
  const steps: ScriptedPart[][] = [];
  const stepText: string[] = [];
  for (let i = 0; i < SCRIPT_LENGTH; i++) {
    const turn = pattern[i % pattern.length];
    if (turn === "fail") {
      // A provider that fails mid-turn — a rate limit, a content filter, a
      // dropped upstream connection.
      steps.push([{ type: "error", error: new Error(`llm blew up on step ${i}`) }]);
      stepText.push("");
    } else if (turn === "tool") {
      steps.push([
        { type: "tool-call", toolCallId: `c${runId}-${i}`, toolName: "lookup", input: "{}" },
      ]);
      stepText.push("");
    } else {
      const words = Array.from({ length: 5 }, (_, w) => `s${i}w${w} `);
      steps.push(words.map((text) => ({ type: "text" as const, text })));
      stepText.push(words.join(""));
    }
  }
  return { steps, stepText };
}

/** Assert an undisturbed turn spoke exactly the text the model produced. */
function checkReplyIntegrity(reply: ReplyRecord, tts: FakeTtsProvider, mon: Monitor): void {
  if (reply.disturbed || reply.failed) return;
  const spoken = norm((tts.last()?.textChunks ?? []).slice(reply.ttsOffset).join(""));
  const expected = norm(reply.expected);
  if (spoken !== expected) {
    mon.flag(
      `reply ${reply.id} spoke ${JSON.stringify(spoken.slice(0, 80))} but the model produced ` +
        `${JSON.stringify(expected.slice(0, 80))}`,
    );
    return;
  }
  if (expected.length > 0) mon.hit("replyIntegrityChecked");
}

function createCallbacks(mon: Monitor, tts: FakeTtsProvider): TransportCallbacks {
  const replyIds = new Set<string>();
  let started = 0;
  let doneCount = 0;
  const afterStop = (name: string): void => {
    if (mon.stopped) mon.flag(`${name} fired after stop() resolved`);
    // A fatal error frame is not a banner: the client has released the
    // microphone and ended the call (aai-ui's `handleErrorEvent`), so the session
    // going on to speak, listen or call tools means the two ends disagree about
    // whether it is alive. Only the paths that really terminate may report
    // fatally — in pipeline mode the provider open/error ones, which call
    // `terminate()`, never a turn-level LLM or TTS failure.
    if (mon.declaredDead !== null) {
      mon.flag(`${name} fired after a fatal [${mon.declaredDead}]`);
    }
  };
  return {
    onReplyStarted: (id: string) => {
      mon.hit("replyStarted");
      afterStop("onReplyStarted");
      if (replyIds.has(id)) mon.flag(`duplicate reply id ${id}`);
      replyIds.add(id);
      started++;
      mon.current = {
        id,
        ttsOffset: tts.last()?.textChunks.length ?? 0,
        expected: id.startsWith("pipeline-greeting") ? GREETING : "",
        disturbed: false,
        failed: false,
        done: false,
      };
    },
    onReplyDone: () => {
      mon.hit("replyDone");
      afterStop("onReplyDone");
      doneCount++;
      if (doneCount > started) mon.flag("onReplyDone without a matching onReplyStarted");
      const reply = mon.current;
      if (reply === null) {
        mon.flag("onReplyDone with no reply in flight");
        return;
      }
      reply.done = true;
      checkReplyIntegrity(reply, tts, mon);
    },
    onCancelled: () => {
      mon.hit("cancelled");
      if (mon.toolInFlight > 0) mon.hit("cancelledWhileToolInFlight");
      mon.disturb();
      afterStop("onCancelled");
    },
    onAudioChunk: () => {
      afterStop("onAudioChunk");
      // session-core emits audio_done together with reply_done, so a chunk
      // after this reply's own replyDone is audio the client never plays — an
      // audibly clipped turn in a session that reports itself healthy.
      if (mon.current?.done === true) {
        mon.flag(`audio chunk after replyDone for ${mon.current.id}`);
      }
    },
    onAudioDone: noop,
    onUserTranscript: () => afterStop("onUserTranscript"),
    onUserTranscriptPartial: () => afterStop("onUserTranscriptPartial"),
    onAgentTranscript: () => afterStop("onAgentTranscript"),
    onAgentTranscriptPartial: () => afterStop("onAgentTranscriptPartial"),
    onToolCall: () => afterStop("onToolCall"),
    onToolCallDone: noop,
    onError: (code: string, _message: string, errOpts?: { fatal?: boolean }) => {
      mon.hit(`error:${code}`);
      if (errOpts?.fatal === false) mon.hit(`nonFatal:${code}`);
      else mon.declaredDead ??= code;
      const reply = mon.current;
      if (reply === null) return;
      if (code === "llm") reply.failed = true;
      if (code === "tts") reply.disturbed = true;
    },
    onSpeechStarted: () => afterStop("onSpeechStarted"),
    onSpeechStopped: noop,
    onSessionReady: noop,
  };
}

/** Wrap the fake model so every request is validated and every stream tracked. */
function instrumentLlm(
  llm: ReturnType<typeof createFakeLanguageModel>,
  stepText: readonly string[],
  mon: Monitor,
  refusals: readonly boolean[],
): void {
  const llmObj = llm as unknown as { doStream: (o: unknown) => Promise<unknown> };
  const rawDoStream = llmObj.doStream;
  let requests = 0;
  llmObj.doStream = async (o) => {
    const opts = o as { prompt?: unknown; abortSignal?: AbortSignal };
    mon.hit("llmRequest");
    // A request that never produces a stream at all. Reported by the catch in
    // `consumeLlmStream` rather than the stream-part handler — a separate
    // reporter, and the other half of what the fatality oracle checks: both end
    // the TURN, neither ends the session.
    if (refusals[requests++ % refusals.length] === true) {
      mon.hit("llmRefused");
      throw new Error("provider refused the connection");
    }
    if (Array.isArray(opts.prompt)) {
      if (opts.prompt.some((m) => (m as PromptMsg).role === "tool")) mon.hit("llmRequestWithTool");
      // Past DEFAULT_MAX_HISTORY the cap trims on every push — the state the
      // orphan-tool-result oracle exists for.
      if (opts.prompt.length >= 201) mon.hit("llmRequestAtHistoryCap");
    }
    for (const problem of promptProblems(opts.prompt)) mon.flag(`LLM request: ${problem}`);
    if (mon.current !== null) mon.current.expected += stepText[mon.consumedSteps] ?? "";
    mon.consumedSteps++;

    mon.liveStreams++;
    mon.maxLiveStreams = Math.max(mon.maxLiveStreams, mon.liveStreams);
    const result = (await rawDoStream.call(llm, o)) as { stream: ReadableStream<unknown> };
    const stream = trackStreamLifetime(result.stream, opts.abortSignal, () => {
      mon.liveStreams--;
    });
    return { ...result, stream };
  };
}

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
  },
): Record<ActionKind, (opener: number) => void> {
  const { stt, tts, transport, utterance } = deps;
  return {
    sttPartial: (opener) => stt.last()?.firePartial(utterance(opener)),
    sttFinal: (opener) => stt.last()?.fireFinal(utterance(opener)),
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

  const mon: Monitor = {
    current: null,
    stopped: false,
    declaredDead: null,
    toolInFlight: 0,
    liveStreams: 0,
    maxLiveStreams: 0,
    consumedSteps: 0,
    flag: (what) => violations.push(`step ${step}: ${what}`),
    hit: (key) => {
      cov[key] = (cov[key] ?? 0) + 1;
    },
    disturb: () => {
      if (mon.current !== null && !mon.current.done) mon.current.disturbed = true;
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
      if (behavior.kind === "slow") await new Promise((r) => setTimeout(r, behavior.ms));
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
    logger: silentLogger,
    falseInterruptionTimeoutMs: 3,
    silenceTimeoutMs: 5,
    interruptionMinDurationMs: 0,
    // Disabled so the reply-integrity oracle is exact: with filler enabled,
    // text reaching TTS that the model never produced is legitimate.
    holdPhrase: "",
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
  });

  const checkSerialization = (): void => {
    if (mon.maxLiveStreams > 1) {
      mon.flag(`${mon.maxLiveStreams} LLM streams open at once — turns are not serialized`);
      mon.maxLiveStreams = 1;
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
      await new Promise((r) => setTimeout(r, 4));
      checkSerialization();
      continue;
    }
    const before = {
      stt: stt.last()?.audioFrames.length ?? 0,
      tts: tts.last()?.textChunks.length ?? 0,
    };
    const fuzzStep = input.steps[step % input.steps.length] as FuzzStep;
    actions[fuzzStep.action](fuzzStep.opener);
    if (fuzzStep.pauseMs !== null) {
      await new Promise((r) => setTimeout(r, fuzzStep.pauseMs ?? 0));
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
  await new Promise((r) => setTimeout(r, 30));

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
    expect(cov.replyStarted ?? 0, "no reply ever started").toBeGreaterThan(120); // ~350
    expect(cov.replyDone ?? 0, "no reply ever completed").toBeGreaterThan(25); // ~95
    expect(cov.replyIntegrityChecked ?? 0, "reply text never checked").toBeGreaterThan(25); // ~95
    expect(cov.toolExecuted ?? 0, "no tool ever ran").toBeGreaterThan(18); // ~62
    expect(cov.llmRequestWithTool ?? 0, "no request carried a tool result").toBeGreaterThan(18); // ~65
    expect(cov.bargeInFromInsideTool ?? 0, "never barged in during a tool").toBeGreaterThan(12); // ~35
    // Barge-in needs the turn to have SPOKEN, so this is the most
    // timing-sensitive counter of the set.
    expect(cov.cancelled ?? 0, "no reply was ever cancelled").toBeGreaterThan(7); // ~33
    // Both ways a turn's LLM can fail, because they are separate reporters: an
    // `error` stream part, and a request that never streams at all. Each keeps
    // the fatality oracle in `createCallbacks` reachable — it passed on arrival
    // precisely because nothing here could fail a turn.
    expect(cov["error:llm"] ?? 0, "no turn's LLM stream ever failed").toBeGreaterThan(8);
    expect(cov.llmRefused ?? 0, "no LLM request was ever refused").toBeGreaterThan(2);
    // And every one of them was reported NON-fatally, so a regression to the
    // `onError` default is a failure here rather than a silent gap.
    expect(cov["nonFatal:llm"] ?? 0).toBe(cov["error:llm"] ?? 0);
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
              { steps: [], script, tools: [{ kind: "ok" }], refusals: [false] },
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
