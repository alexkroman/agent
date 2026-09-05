// Stubbed STT / LLM / TTS, so a load test measures the AGENT rather than three
// provider networks.
//
// Copied over a scaffolded project by `scripts/loadtest-boot.sh stub`, which is
// why it lives here rather than in a template: it is bench scaffolding, not
// something to ship to a user.
//
// ## Why the EVAL fakes cannot serve this
//
// `installStubSpeechProviders` (`@alexkroman1/aai-runtime/eval`) exists for exactly this
// shape and is deliberately narrower. Its STT ignores audio — a case drives a
// turn by calling `commit()` — and its TTS forwards no audio at all, on purpose:
// a fake that forwarded silence would make every case after the greeting look
// like a barge-in. A load test arrives over a real WebSocket with no seam to
// call, so the client's own audio has to be what produces a transcript, and the
// reply has to produce frames the client receives. Otherwise the two halves of a
// turn are never exercised and the run measures a handshake.
//
// The spurious-barge-in hazard does not arise here because the driver waits for
// `reply.completed` before speaking again (`scripts/loadtest-turns.mjs`).

import type {
  SttEvents,
  SttOpener,
  SttSession,
  TtsEvents,
  TtsOpener,
  TtsSession,
} from "@alexkroman1/aai/host-internal";
import type { SttProvider } from "@alexkroman1/aai/stt";
import type { TtsProvider } from "@alexkroman1/aai/tts";
import { registerSttKind, registerTtsKind } from "@alexkroman1/aai-runtime";
import { installStubLlm } from "@alexkroman1/aai-runtime/eval";

/**
 * A minimal emitter with the `on(event, fn)` shape both provider contracts want.
 *
 * Inline rather than `nanoevents`, which the SDK's own adapters use but which is
 * not a dependency of a scaffolded project — and a bench should not add one to
 * measure the thing it is benching.
 */
function emitter<E extends Record<string, (...args: never[]) => void>>() {
  const handlers: { [K in keyof E]?: E[K][] } = {};
  return {
    on<K extends keyof E>(event: K, fn: E[K]) {
      const held = handlers[event] ?? [];
      held.push(fn);
      handlers[event] = held;
      return () => {
        handlers[event] = handlers[event]?.filter((one) => one !== fn);
      };
    },
    emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>) {
      // `Reflect.apply` rather than a cast. `fn` is `E[K]`, whose constraint
      // declares `(...args: never[]) => void`, so asserting it to
      // `(...a: unknown[]) => void` is contravariantly UNSOUND and TS2352 says
      // so — `unknown` is not assignable to `never`. Widening through `unknown`
      // silences it and keeps the unsoundness; `Reflect.apply` takes a
      // `Function` and an `ArrayLike`, which `fn` and `args` genuinely are.
      for (const fn of handlers[event] ?? []) Reflect.apply(fn, undefined, args);
    },
  };
}

/** The credential both stubs declare. A stage still needs one to resolve. */
const KEY_ENV = "AAI_LOADTEST_STUB_KEY";

/** Client samples that stand for one finished utterance — 0.5s at 16 kHz. */
const SAMPLES_PER_UTTERANCE = 8000;

/** PCM16 frames a reply forwards, and their size (50ms at 24 kHz). */
const REPLY_FRAMES = 4;
const REPLY_FRAME_SAMPLES = 1200;

/**
 * STT that commits a transcript from the CLIENT'S OWN AUDIO.
 *
 * One `final` per {@link SAMPLES_PER_UTTERANCE}, with a `partial` first so the
 * barge-in path is driven the way a real provider drives it. The counter resets
 * after each commit, so a client that keeps sending audio keeps taking turns —
 * which is what makes a sustained load test possible at all.
 */
function stubSttOpener(): SttOpener {
  return {
    name: "loadtest-stub-stt",
    async open(): Promise<SttSession> {
      const events = emitter<SttEvents>();
      let samples = 0;
      let turn = 0;
      return {
        sendAudio(pcm: Int16Array) {
          samples += pcm.length;
          if (samples < SAMPLES_PER_UTTERANCE) return;
          samples = 0;
          turn += 1;
          const text = `load test utterance ${turn}`;
          events.emit("partial", text);
          events.emit("final", text);
        },
        on: (event, fn) => events.on(event, fn),
        close: async () => undefined,
      };
    },
  };
}

/** TTS that forwards REAL frames, which is the half the eval fake omits. */
function stubTtsOpener(): TtsOpener {
  return {
    name: "loadtest-stub-tts",
    async open(): Promise<TtsSession> {
      const events = emitter<TtsEvents>();
      const frame = new Int16Array(REPLY_FRAME_SAMPLES);
      for (let i = 0; i < frame.length; i++) frame[i] = (i % 256) - 128;
      return {
        sendText() {
          for (let i = 0; i < REPLY_FRAMES; i++) events.emit("audio", frame);
        },
        flush() {
          events.emit("done");
        },
        cancel() {
          events.emit("done");
        },
        on: (event, fn) => events.on(event, fn),
        close: async () => undefined,
      };
    },
  };
}

// `open` returns the OPENER — the registry calls it once per resolve — and the
// SESSION comes from the opener's own `open()`. Returning a session here gives a
// stage that resolves and then has no `sendAudio`.
registerSttKind("loadtest-stub-stt", { envVar: KEY_ENV, open: () => stubSttOpener() });
registerTtsKind("loadtest-stub-tts", { envVar: KEY_ENV, open: () => stubTtsOpener() });

/**
 * The descriptors `agent()` takes, written out rather than built by a factory:
 * a custom kind has no factory, which is the whole point of the registry.
 */
export const stubStt: SttProvider = { kind: "loadtest-stub-stt", options: {} };
export const stubTts: TtsProvider = { kind: "loadtest-stub-tts", options: {} };
export const stubLlm = installStubLlm(["Acknowledged. Anything else?"]);

/** Both env keys a stubbed agent needs — the boot script writes them to `.env`. */
export const stubEnv = { [KEY_ENV]: "stub", ...stubLlm.env };
