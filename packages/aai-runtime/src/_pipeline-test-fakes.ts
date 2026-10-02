// Copyright 2025 the AAI authors. MIT license.
/**
 * In-memory fake providers + fake `LanguageModel` for pipeline-session tests.
 *
 * These fakes do not touch the network. Each `createFake*Provider()` returns a
 * provider whose `open()` records the most recently opened session so tests
 * can reach into it via `.last()` and drive events (partial/final transcripts,
 * TTS chunks) or observe calls (`sendText`, `flush`, `cancel`).
 *
 * The fake `LanguageModel` implements the minimum of {@link LanguageModelV3}
 * required by `streamText` — `doStream()` returns a `ReadableStream` of
 * {@link LanguageModelV3StreamPart}s produced from a scripted sequence.
 *
 * @internal Not part of the public API.
 */

import type { LlmProvider } from "@alexkroman1/aai/llm";
import type { SttProvider } from "@alexkroman1/aai/stt";
import type { TtsProvider } from "@alexkroman1/aai/tts";
import type { LanguageModel } from "ai";
import { createNanoEvents, type Emitter } from "nanoevents";
import { onTestFinished, vi } from "vitest";
import type {
  SttEvents,
  SttOpener,
  SttOpenOptions,
  SttSession,
  SttTurnMeta,
  TtsEvents,
  TtsOpener,
  TtsOpenOptions,
  TtsSession,
  TtsWordTiming,
  Unsubscribe,
} from "./providers/openers.ts";
import { registerLlmKind, registerSttKind, registerTtsKind } from "./providers/resolve.ts";

function makeCodedError<C extends string>(code: C, message: string): Error & { code: C } {
  return Object.assign(new Error(message), { code });
}

// ─── Fake STT ───────────────────────────────────────────────────────────────

type SttErrorCode = "stt_stream_error" | "stt_connect_failed" | "stt_auth_failed";

export type FakeSttSession = SttSession & {
  readonly emitter: Emitter<SttEvents>;
  readonly options: SttOpenOptions;
  readonly audioFrames: Int16Array[];
  /** Spy: assert `toHaveBeenCalled()` for "this session was closed". */
  readonly close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  /** Recorded pushes of the end-of-turn window — see `pipeline-endpointing.ts`. */
  readonly updateEndpointing: ReturnType<typeof vi.fn<(minTurnSilenceMs: number) => void>>;
  /** Recorded forced ends of turn — what `userTurnLimit` asks for. */
  readonly forceEndOfTurn: ReturnType<typeof vi.fn<() => void>>;
  /** `meta` carries provider turn signals, e.g. `endOfTurnConfidence`. */
  firePartial(text: string, meta?: SttTurnMeta): void;
  /** As {@link FakeSttSession.firePartial}, for the committed transcript. */
  fireFinal(text: string, meta?: SttTurnMeta): void;
  fireError(code: SttErrorCode, message: string): void;
};

export type FakeSttProvider = SttOpener & {
  /** The most recently opened session, or undefined if `open()` hasn't been called. */
  last(): FakeSttSession | undefined;
  readonly sessions: FakeSttSession[];
};

export function createFakeSttProvider(): FakeSttProvider {
  const sessions: FakeSttSession[] = [];
  return {
    name: "fake-stt",
    sessions,
    last: () => sessions.at(-1),
    async open(options: SttOpenOptions): Promise<SttSession> {
      const emitter = createNanoEvents<SttEvents>();
      const audioFrames: Int16Array[] = [];
      const session: FakeSttSession = {
        emitter,
        options,
        audioFrames,
        sendAudio: vi.fn((pcm: Int16Array) => {
          audioFrames.push(pcm);
        }),
        updateEndpointing: vi.fn((_minTurnSilenceMs: number) => {
          /* recorded via the mock's .mock.calls */
        }),
        forceEndOfTurn: vi.fn(() => {
          /* recorded via the mock's .mock.calls */
        }),
        on: emitter.on.bind(emitter) as SttSession["on"],
        close: vi.fn(async () => undefined),
        firePartial(text, meta) {
          emitter.emit("partial", text, meta);
        },
        fireFinal(text, meta) {
          emitter.emit("final", text, meta);
        },
        fireError(code, message) {
          emitter.emit("error", makeCodedError(code, message) as Parameters<SttEvents["error"]>[0]);
        },
      };
      sessions.push(session);
      return session;
    },
  };
}

// ─── Fake TTS ───────────────────────────────────────────────────────────────

type TtsErrorCode = "tts_stream_error" | "tts_connect_failed" | "tts_auth_failed";

/**
 * A `TtsSession` that only records the text it was told to speak.
 *
 * The cut-down sibling of {@link createFakeTtsProvider}: a spec whose claim is
 * "these words reached TTS in this order" wants the list and none of the
 * lifecycle — and the four inert members are exactly what makes it look small
 * enough to re-type, which two suites did, byte for byte. It hands back the
 * SESSION rather than an opener because both callers hold the transport's
 * `tts` slot directly.
 */
export function recordingTts(spoken: string[]): TtsSession {
  return {
    sendText: (text: string) => spoken.push(text),
    flush: () => undefined,
    cancel: () => undefined,
    on: (): Unsubscribe => () => undefined,
    close: () => Promise.resolve(),
  };
}

export type FakeTtsSession = TtsSession & {
  readonly emitter: Emitter<TtsEvents>;
  readonly options: TtsOpenOptions;
  readonly textChunks: string[];
  /** Spy: assert `toHaveBeenCalled()` for "this session was closed". */
  readonly close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly sendText: ReturnType<typeof vi.fn<(text: string) => void>>;
  readonly flush: ReturnType<typeof vi.fn<() => void>>;
  readonly cancel: ReturnType<typeof vi.fn<() => void>>;
  fireAudio(pcm: Int16Array): void;
  /** Emit provider word timings (offsets in ms into the current turn's audio). */
  fireWords(words: readonly TtsWordTiming[]): void;
  fireError(code: TtsErrorCode, message: string): void;
};

export type FakeTtsProvider = TtsOpener & {
  /** The most recently opened session, or undefined if `open()` hasn't been called. */
  last(): FakeTtsSession | undefined;
  readonly sessions: FakeTtsSession[];
};

/**
 * Fake TTS provider. By default, `flush()` synchronously emits a single `done`
 * event so tests don't have to script the drain separately. Pass
 * `{ autoDoneOnFlush: false }` to drive `done` manually.
 */
export function createFakeTtsProvider(
  options: { autoDoneOnFlush?: boolean } = {},
): FakeTtsProvider {
  const autoDoneOnFlush = options.autoDoneOnFlush ?? true;
  const sessions: FakeTtsSession[] = [];
  return {
    name: "fake-tts",
    sessions,
    last: () => sessions.at(-1),
    async open(options: TtsOpenOptions): Promise<TtsSession> {
      const emitter = createNanoEvents<TtsEvents>();
      const textChunks: string[] = [];
      const sendText = vi.fn((text: string) => {
        textChunks.push(text);
      });
      const flush = vi.fn(() => {
        if (autoDoneOnFlush) emitter.emit("done");
      });
      const cancel = vi.fn(() => {
        emitter.emit("done");
      });
      const session: FakeTtsSession = {
        emitter,
        options,
        textChunks,
        sendText,
        flush,
        cancel,
        on: emitter.on.bind(emitter) as TtsSession["on"],
        close: vi.fn(async () => undefined),
        fireAudio(pcm) {
          emitter.emit("audio", pcm);
        },
        fireWords(words) {
          emitter.emit("words", words);
        },
        fireError(code, message) {
          emitter.emit("error", makeCodedError(code, message) as Parameters<TtsEvents["error"]>[0]);
        },
      };
      sessions.push(session);
      return session;
    },
  };
}

/** A manually advanced clock — the transport's `heardNow` seam. */
export interface TestClock {
  now(): number;
  advance(ms: number): void;
}

/**
 * A clock a spec drives by hand, so "the caller heard 1.2 seconds" costs no
 * wall-clock time. Starts well above zero: the playback clock treats 0 as "no
 * audio queued", and a session starting at the epoch is not a case worth
 * modelling.
 */
export function createTestClock(startMs = 1_000_000): TestClock {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

/**
 * Forward `forwardMs` of TTS audio for the live reply and let `elapsedMs` of it
 * play out on the injected clock — i.e. "the agent said this much, and the
 * caller has heard this much of it". Defaults to fully heard.
 *
 * Pair with `heardLagMs: 0`: at the shipped lag every spec-sized reply is the
 * heard-nothing case (see `PipelineTransportOptions.heardLagMs`).
 */
export function speakFor(
  tts: FakeTtsProvider,
  clock: TestClock,
  forwardMs: number,
  elapsedMs: number = forwardMs,
  sampleRate = 24_000,
): void {
  tts.last()?.fireAudio(new Int16Array(Math.round((sampleRate * forwardMs) / 1000)));
  clock.advance(elapsedMs);
}

/**
 * A provider whose `open()` throws with `code` — an STT opener for an `stt_*`
 * code, a TTS one for a `tts_*` code. For atomic provider open and failover: TTS
 * is not opened when STT fails, and STT is closed when TTS fails.
 */
export function createFailingProvider(code: SttErrorCode, message: string): SttOpener;
export function createFailingProvider(code: TtsErrorCode, message: string): TtsOpener;
export function createFailingProvider(
  code: SttErrorCode | TtsErrorCode,
  message: string,
): SttOpener | TtsOpener {
  return {
    name: code.startsWith("stt_") ? "failing-stt" : "failing-tts",
    async open(): Promise<never> {
      throw makeCodedError(code, message);
    },
  };
}

// ─── Fake LLM ───────────────────────────────────────────────────────────────

// Re-exported so `_pipeline-test-fakes.ts` stays the one import path for specs;
// the fake model itself lives in `_fake-llm.ts` for file-length reasons.
export {
  createFakeLanguageModel,
  createScriptedOneShotModel,
  type FakeLanguageModel,
  type ScriptedPart,
  type ScriptedTurn,
} from "./_fake-llm.ts";

// ─── Registering fakes as provider kinds ─────────────────────────────────────

/** Env var the fake STT kind's credential is read from. */
export const FAKE_STT_API_KEY_ENV = "FAKE_STT_API_KEY";
/** Env var the fake TTS kind's credential is read from. */
export const FAKE_TTS_API_KEY_ENV = "FAKE_TTS_API_KEY";
/** Env var the fake LLM kind's credential is read from. */
export const FAKE_LLM_API_KEY_ENV = "FAKE_LLM_API_KEY";

const FAKE_STT_KIND = "fake-stt";
const FAKE_TTS_KIND = "fake-tts";
const FAKE_LLM_KIND = "fake-llm";

/**
 * Register fakes as real provider kinds and hand back the descriptors that
 * resolve to them, so a test can drive `createRuntime` through exactly the
 * descriptor path production uses.
 *
 * A registered kind resolves with its own env var like any other provider, so
 * `RuntimeOptions.stt/llm/tts` take descriptors only — no pre-resolved opener for
 * API-key routing to guess a vendor for.
 *
 * Call it inside a test (or a `beforeEach`): the registry is module-level, so
 * the registration is released by `onTestFinished`. `unregister` is idempotent,
 * for a spec that has to release it mid-test.
 */
export function registerFakeProviders(fakes: {
  stt?: FakeSttProvider;
  tts?: FakeTtsProvider;
  llm?: LanguageModel;
}): {
  /** Descriptors to pass to `createRuntime`. Only the supplied fakes appear. */
  readonly stt: SttProvider | undefined;
  readonly tts: TtsProvider | undefined;
  readonly llm: LlmProvider | undefined;
  /** Credentials for the registered fakes — pass as `createRuntime({ env })`. */
  readonly env: Record<string, string>;
  /** Restore the registries now; also runs when the test finishes. Idempotent. */
  unregister(): void;
} {
  const undo: (() => void)[] = [];

  // Fake credentials are handed back as `env` for the spec to pass to
  // createRuntime, NOT seeded into process.env: credential resolution reads the
  // agent env only (see requireApiKey), so a process.env seed would both fail
  // to work and quietly re-assert the fallback this codebase deliberately
  // removed.
  const env: Record<string, string> = Object.fromEntries(
    [FAKE_STT_API_KEY_ENV, FAKE_TTS_API_KEY_ENV, FAKE_LLM_API_KEY_ENV].map((name) => [
      name,
      `${name}-value`,
    ]),
  );

  if (fakes.stt) {
    const stt = fakes.stt;
    undo.push(registerSttKind(FAKE_STT_KIND, { envVar: FAKE_STT_API_KEY_ENV, open: () => stt }));
  }
  if (fakes.tts) {
    const tts = fakes.tts;
    undo.push(registerTtsKind(FAKE_TTS_KIND, { envVar: FAKE_TTS_API_KEY_ENV, open: () => tts }));
  }
  if (fakes.llm) {
    const llm = fakes.llm;
    undo.push(
      registerLlmKind(FAKE_LLM_KIND, {
        envVar: FAKE_LLM_API_KEY_ENV,
        label: "Fake",
        create: () => llm,
      }),
    );
  }

  const unregister = (): void => {
    for (const fn of undo.splice(0).reverse()) fn();
  };
  onTestFinished(unregister);
  return {
    env,
    stt: fakes.stt ? { kind: FAKE_STT_KIND, options: {} } : undefined,
    tts: fakes.tts ? { kind: FAKE_TTS_KIND, options: {} } : undefined,
    llm: fakes.llm ? { kind: FAKE_LLM_KIND, options: { model: "fake-llm" } } : undefined,
    unregister,
  };
}
