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
 * rather than a fixed bug.
 */

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
  mulberry32,
  norm,
  type PromptMsg,
  promptProblems,
  trackStreamLifetime,
} from "./_pipeline-fuzz-model.ts";

/** Seeds run as short sessions (structural + integrity invariants). */
const SHORT_SEEDS = 40;
/** Seeds run long enough to push the LLM history past DEFAULT_MAX_HISTORY. */
const LONG_SEEDS = 3;

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
  toolInFlight: number;
  liveStreams: number;
  maxLiveStreams: number;
  consumedSteps: number;
  flag: (what: string) => void;
  hit: (key: string) => void;
  /** Mark the in-flight reply as disturbed (an abort is about to touch it). */
  disturb: () => void;
}

/** Build the LLM script: text-only turns interleaved with tool-call turns. */
function buildScript(
  rnd: () => number,
  seed: number,
): { steps: ScriptedPart[][]; stepText: string[] } {
  const steps: ScriptedPart[][] = [];
  const stepText: string[] = [];
  for (let i = 0; i < 2000; i++) {
    if (rnd() < 0.4) {
      steps.push([
        { type: "tool-call", toolCallId: `c${seed}-${i}`, toolName: "lookup", input: "{}" },
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
    onUserTranscriptPartial: noop,
    onAgentTranscript: () => afterStop("onAgentTranscript"),
    onAgentTranscriptPartial: noop,
    onToolCall: noop,
    onToolCallDone: noop,
    onError: (code: string) => {
      mon.hit(`error:${code}`);
      const reply = mon.current;
      if (reply === null) return;
      if (code === "llm") reply.failed = true;
      if (code === "tts") reply.disturbed = true;
    },
    onSpeechStarted: noop,
    onSpeechStopped: noop,
    onSessionReady: noop,
  };
}

/** Wrap the fake model so every request is validated and every stream tracked. */
function instrumentLlm(
  llm: ReturnType<typeof createFakeLanguageModel>,
  stepText: readonly string[],
  mon: Monitor,
): void {
  const llmObj = llm as unknown as { doStream: (o: unknown) => Promise<unknown> };
  const rawDoStream = llmObj.doStream;
  llmObj.doStream = async (o) => {
    const opts = o as { prompt?: unknown; abortSignal?: AbortSignal };
    mon.hit("llmRequest");
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

/** The events a generator step can fire. */
function buildActions(
  mon: Monitor,
  deps: {
    stt: FakeSttProvider;
    tts: FakeTtsProvider;
    transport: ReturnType<typeof createPipelineTransport>;
    utterance: () => string;
    longSession: boolean;
    armBargeInFromTool: () => void;
  },
): (() => void)[] {
  const { stt, tts, transport, utterance } = deps;
  return [
    () => stt.last()?.firePartial(utterance()),
    () => stt.last()?.fireFinal(utterance()),
    () => {
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
    () => {
      mon.disturb();
      transport.cancelReply();
    },
    // reset() clears history, so a long session that resets can never reach the
    // cap — the state its seeds exist to exercise.
    ...(deps.longSession
      ? []
      : [
          (): void => {
            mon.disturb();
            // Optional on Transport (S2S has no conversation state of its own).
            transport.reset?.();
          },
        ]),
    () => transport.sendUserAudio(new Uint8Array(320)),
    deps.armBargeInFromTool,
  ];
}

async function runSeed(
  seed: number,
  steps: number,
  cov: Coverage,
  seedOpts: SeedOptions = {},
): Promise<string[]> {
  const longSession = seedOpts.longSession === true;
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const violations: string[] = [];
  let step = 0;

  const mon: Monitor = {
    current: null,
    stopped: false,
    toolInFlight: 0,
    liveStreams: 0,
    maxLiveStreams: 0,
    consumedSteps: 0,
    flag: (what) => violations.push(`seed ${seed} step ${step}: ${what}`),
    hit: (key) => {
      cov[key] = (cov[key] ?? 0) + 1;
    },
    disturb: () => {
      if (mon.current !== null && !mon.current.done) mon.current.disturbed = true;
    },
  };

  const stt: FakeSttProvider = createFakeSttProvider();
  const tts: FakeTtsProvider = createFakeTtsProvider();
  const { steps: script, stepText } = buildScript(rnd, seed);
  const llm = createFakeLanguageModel({ steps: script, delayMs: 1 });
  instrumentLlm(llm, stepText, mon);

  // Bias toward the rare state a uniform random walk barely reaches: a barge-in
  // landing INSIDE a tool execution.
  let bargeInFromTool = false;
  const executeTool = async (): Promise<string> => {
    mon.hit("toolExecuted");
    mon.toolInFlight++;
    try {
      if (bargeInFromTool) {
        bargeInFromTool = false;
        mon.hit("bargeInFromInsideTool");
        stt.last()?.firePartial("no wait stop that please");
      }
      const roll = rnd();
      if (roll < 0.1) throw new Error("tool blew up");
      if (roll < 0.4) await new Promise((r) => setTimeout(r, Math.floor(rnd() * 8)));
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
    sid: `fuzz-${seed}`,
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
  const utterance = (): string => {
    seq++;
    const opener = pick(["please look it up", "tell me more", "wait stop that", "yes go on"]);
    return `${opener} number ${seq}`;
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

  for (step = 0; step < steps; step++) {
    if (longSession) {
      // Plain back-to-back turns: the point is to accumulate history, and the
      // random walk spends most steps on events that commit no turn.
      stt.last()?.fireFinal(utterance());
      await new Promise((r) => setTimeout(r, 4));
      checkSerialization();
      continue;
    }
    const before = {
      stt: stt.last()?.audioFrames.length ?? 0,
      tts: tts.last()?.textChunks.length ?? 0,
    };
    pick(actions)();
    if (rnd() < 0.6) await new Promise((r) => setTimeout(r, Math.floor(rnd() * 5)));
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

interface BatchResult {
  cov: Coverage;
  /** Sliced: a systemic break should report a readable sample, not hundreds. */
  violations: string[];
  unhandled: string[];
}

/** Run a batch of seeds, collecting violations, unhandled rejections, coverage. */
async function runBatch(
  batch: { seed: number; steps: number; opts?: SeedOptions }[],
): Promise<BatchResult> {
  const unhandled: string[] = [];
  const onUnhandled = (e: unknown): void => {
    unhandled.push(String(e));
  };
  process.on("unhandledRejection", onUnhandled);
  const cov: Coverage = {};
  const violations: string[] = [];
  try {
    for (const { seed, steps, opts } of batch) {
      violations.push(...(await runSeed(seed, steps, cov, opts)));
    }
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return { cov, violations: violations.slice(0, 8), unhandled };
}

// Split into two tests rather than one: each gets its own timeout budget, and
// the integration profile allows 30s. One combined run measured ~10s locally,
// which a loaded shared runner can stretch past the limit.
describe("pipeline transport — randomized interleaving", () => {
  test("global invariants hold across random event orderings", async () => {
    const { cov, violations, unhandled } = await runBatch(
      Array.from({ length: SHORT_SEEDS }, (_, i) => ({ seed: i + 1, steps: 30 })),
    );
    expect({ violations, unhandled }).toEqual({ violations: [], unhandled: [] });

    // Coverage floors — see the module doc. Set well below measured actuals
    // (noted alongside) because the random walk's yield depends on real
    // timing: these exist to catch a generator that stopped reaching a state,
    // not to pin a count.
    expect(cov.replyStarted ?? 0).toBeGreaterThan(60); // ~370
    expect(cov.replyDone ?? 0).toBeGreaterThan(20); // ~250
    expect(cov.replyIntegrityChecked ?? 0).toBeGreaterThan(20); // ~250
    expect(cov.toolExecuted ?? 0).toBeGreaterThan(20); // ~200
    expect(cov.llmRequestWithTool ?? 0).toBeGreaterThan(20); // ~400
    expect(cov.bargeInFromInsideTool ?? 0).toBeGreaterThan(8); // ~37
    // Barge-in needs the turn to have SPOKEN, so this is the most
    // timing-sensitive counter of the set — measured ~15.
    expect(cov.cancelled ?? 0).toBeGreaterThan(4);
  });

  test("global invariants hold across a long session past the history cap", async () => {
    const { cov, violations, unhandled } = await runBatch(
      Array.from({ length: LONG_SEEDS }, (_, i) => ({
        seed: 1000 + i + 1,
        steps: 200,
        opts: {
          longSession: true,
          // Vary the starting alignment: whether a trim splits a tool pair
          // depends on where the window boundary falls inside a turn.
          seedHistory: (i + 1) % 4,
        },
      })),
    );
    expect({ violations, unhandled }).toEqual({ violations: [], unhandled: [] });

    // The state this batch exists for: past DEFAULT_MAX_HISTORY the cap trims
    // on every push, which is what can orphan a tool result. Measured ~66.
    expect(cov.llmRequestAtHistoryCap ?? 0).toBeGreaterThan(10);
  });
});
