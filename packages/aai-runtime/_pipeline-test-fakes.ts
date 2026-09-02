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
} from "@alexkroman1/aai/host-internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import type { SttProvider } from "@alexkroman1/aai/stt";
import type { TtsProvider } from "@alexkroman1/aai/tts";
import type { LanguageModel } from "ai";
import { createNanoEvents, type Emitter } from "nanoevents";
import { vi } from "vitest";
import { registerLlmKind, registerSttKind, registerTtsKind } from "./providers/resolve.ts";

function makeCodedError<C extends string>(code: C, message: string): Error & { code: C } {
  return Object.assign(new Error(message), { code });
}

// ─── Fake STT ───────────────────────────────────────────────────────────────

type SttErrorCode = "stt_stream_error" | "stt_connect_failed" | "stt_auth_failed";

export type FakeSttSession = SttSession & {
  readonly emitter: Emitter<SttEvents>;
  readonly opts: SttOpenOptions;
  readonly audioFrames: Int16Array[];
  readonly closed: { value: boolean };
  readonly updateAgentContext: ReturnType<typeof vi.fn<(text: string) => void>>;
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
    async open(opts: SttOpenOptions): Promise<SttSession> {
      const emitter = createNanoEvents<SttEvents>();
      const audioFrames: Int16Array[] = [];
      const closed = { value: false };
      const session: FakeSttSession = {
        emitter,
        opts,
        audioFrames,
        closed,
        sendAudio: vi.fn((pcm: Int16Array) => {
          audioFrames.push(pcm);
        }),
        updateAgentContext: vi.fn((_text: string) => {
          /* recorded via the mock's .mock.calls */
        }),
        on: emitter.on.bind(emitter) as SttSession["on"],
        close: vi.fn(async () => {
          closed.value = true;
        }),
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
  readonly opts: TtsOpenOptions;
  readonly textChunks: string[];
  readonly closed: { value: boolean };
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
    async open(opts: TtsOpenOptions): Promise<TtsSession> {
      const emitter = createNanoEvents<TtsEvents>();
      const textChunks: string[] = [];
      const closed = { value: false };
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
        opts,
        textChunks,
        closed,
        sendText,
        flush,
        cancel,
        on: emitter.on.bind(emitter) as TtsSession["on"],
        close: vi.fn(async () => {
          closed.value = true;
        }),
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
 * Fake STT provider that throws on `open()` with a given error code. Used to
 * test atomic provider open — TTS should not be opened at all when STT fails.
 */
export function createFailingSttProvider(code: SttErrorCode, message: string): SttOpener {
  return {
    name: "failing-stt",
    async open(): Promise<SttSession> {
      throw makeCodedError(code, message);
    },
  };
}

/**
 * Fake TTS provider that throws on `open()` with a given error code. Used to
 * test atomic provider open — STT should be closed when TTS fails.
 */
export function createFailingTtsProvider(code: TtsErrorCode, message: string): TtsOpener {
  return {
    name: "failing-tts",
    async open(): Promise<TtsSession> {
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
 * `RuntimeOptions.stt/llm/tts` used to accept a pre-resolved opener as a test
 * escape hatch. That union was why API-key routing had to sniff `opener.name`
 * and guess a registry entry — a kindless value carries no kind — which in turn
 * needed a wrong-vendor fallback. Registering a kind removes the need for any of
 * that: a fake resolves with its own env var like any other provider.
 *
 * Always release the registration (the registry is module-level):
 *
 * ```ts no-check
 * const fakes = registerFakeProviders({ stt, tts, llm });
 * try { ... } finally { fakes.unregister(); }
 * ```
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
  /** Restore the registries. Call in a `finally` / cleanup hook. */
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

  return {
    env,
    stt: fakes.stt ? { kind: FAKE_STT_KIND, options: {} } : undefined,
    tts: fakes.tts ? { kind: FAKE_TTS_KIND, options: {} } : undefined,
    llm: fakes.llm ? { kind: FAKE_LLM_KIND, options: {} } : undefined,
    unregister(): void {
      for (const fn of undo.reverse()) fn();
    },
  };
}
