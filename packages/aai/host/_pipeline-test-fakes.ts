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

import type { LanguageModel } from "ai";
import { createNanoEvents, type Emitter } from "nanoevents";
import { vi } from "vitest";
import type {
  SttEvents,
  SttOpenOptions,
  SttProvider,
  SttSession,
  TtsEvents,
  TtsOpenOptions,
  TtsProvider,
  TtsSession,
} from "../sdk/providers.ts";

// ─── Fake STT ───────────────────────────────────────────────────────────────

export type FakeSttSession = SttSession & {
  readonly emitter: Emitter<SttEvents>;
  readonly opts: SttOpenOptions;
  readonly audioFrames: Int16Array[];
  readonly closed: { value: boolean };
  firePartial(text: string): void;
  fireFinal(text: string): void;
  fireError(
    code: "stt_stream_error" | "stt_connect_failed" | "stt_auth_failed",
    message: string,
  ): void;
};

export type FakeSttProvider = SttProvider & {
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
        on: emitter.on.bind(emitter) as SttSession["on"],
        close: vi.fn(async () => {
          closed.value = true;
        }),
        firePartial(text: string) {
          emitter.emit("partial", text);
        },
        fireFinal(text: string) {
          emitter.emit("final", text);
        },
        fireError(code, message) {
          const err = Object.assign(new Error(message), { code }) as Parameters<
            SttEvents["error"]
          >[0];
          emitter.emit("error", err);
        },
      };
      sessions.push(session);
      return session;
    },
  };
}

// ─── Fake TTS ───────────────────────────────────────────────────────────────

export type FakeTtsSession = TtsSession & {
  readonly emitter: Emitter<TtsEvents>;
  readonly opts: TtsOpenOptions;
  readonly textChunks: string[];
  readonly closed: { value: boolean };
  readonly sendText: ReturnType<typeof vi.fn<(text: string) => void>>;
  readonly flush: ReturnType<typeof vi.fn<() => void>>;
  readonly cancel: ReturnType<typeof vi.fn<() => void>>;
  fireAudio(pcm: Int16Array): void;
  fireError(
    code: "tts_stream_error" | "tts_connect_failed" | "tts_auth_failed",
    message: string,
  ): void;
};

export type FakeTtsProvider = TtsProvider & {
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
        fireAudio(pcm: Int16Array) {
          emitter.emit("audio", pcm);
        },
        fireError(code, message) {
          const err = Object.assign(new Error(message), { code }) as Parameters<
            TtsEvents["error"]
          >[0];
          emitter.emit("error", err);
        },
      };
      sessions.push(session);
      return session;
    },
  };
}

// ─── Fake LLM ───────────────────────────────────────────────────────────────

/**
 * A scripted stream part. `text` yields a `text-delta` in the LLM provider's
 * raw wire format; `tool-call` / `tool-result` emit the corresponding parts
 * (v3 provider spec: `toolCallId`, `toolName`, `input` as JSON string for
 * calls, `result` as JSON-serialisable value for results).
 */
export type ScriptedPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown }
  | { type: "error"; error: unknown };

/**
 * Shape of the single stream part yielded by an LLM provider's `doStream()`.
 * This is a loose local definition — the real type lives in `@ai-sdk/provider`
 * as `LanguageModelV3StreamPart`, but we don't want a direct dependency on
 * that package. The test fakes only need enough of the shape that the
 * `ai` package's `streamText` will forward through to consumers.
 */
type StreamPart =
  | { type: "stream-start"; warnings: never[] }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: NonNullable<unknown> }
  | { type: "error"; error: unknown }
  | {
      type: "finish";
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      finishReason: string;
    };

function scriptedPartToStreamPart(part: ScriptedPart, textId: string): StreamPart {
  switch (part.type) {
    case "text":
      return { type: "text-delta", id: textId, delta: part.text };
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      };
    case "tool-result":
      return {
        type: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        result: part.result as NonNullable<unknown>,
      };
    case "error":
      return { type: "error", error: part.error };
    default: {
      const never: never = part;
      return never;
    }
  }
}

/** Wait `ms` or resolve immediately when `signal` aborts. */
function delayOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

async function streamScript(
  controller: ReadableStreamDefaultController<StreamPart>,
  script: ScriptedPart[],
  delayMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const textId = "text-1";
  controller.enqueue({ type: "stream-start", warnings: [] });
  controller.enqueue({ type: "text-start", id: textId });
  try {
    for (const part of script) {
      if (signal?.aborted) break;
      if (delayMs !== undefined && delayMs > 0) await delayOrAbort(delayMs, signal);
      if (signal?.aborted) break;
      controller.enqueue(scriptedPartToStreamPart(part, textId));
    }
  } finally {
    controller.enqueue({ type: "text-end", id: textId });
    controller.enqueue({
      type: "finish",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: signal?.aborted ? "other" : "stop",
    });
    controller.close();
  }
}

/**
 * Create a fake {@link LanguageModel} that yields a scripted sequence of
 * parts when `streamText` drives `doStream()`. The fake ignores the prompt
 * and tools — it simply replays the script.
 *
 * Pass `{ delayMs: N }` to space out parts with `setTimeout(N)` so that
 * barge-in tests can abort mid-stream deterministically.
 *
 * The returned value is cast to the `LanguageModel` union because we
 * implement the provider shape structurally rather than importing the
 * full `@ai-sdk/provider` types into the aai package.
 */
export function createFakeLanguageModel(options: {
  script: ScriptedPart[];
  delayMs?: number;
}): LanguageModel {
  const { script, delayMs } = options;
  const model = {
    specificationVersion: "v3" as const,
    provider: "fake-llm",
    modelId: "fake-llm-1",
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate(): Promise<never> {
      throw new Error("fake LLM: doGenerate not implemented");
    },
    async doStream(opts: { abortSignal?: AbortSignal }): Promise<{
      stream: ReadableStream<StreamPart>;
    }> {
      const stream = new ReadableStream<StreamPart>({
        start(controller) {
          void streamScript(controller, script, delayMs, opts.abortSignal);
        },
      });
      return { stream };
    },
  };
  return model as unknown as LanguageModel;
}
