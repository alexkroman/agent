// Copyright 2026 the AAI authors. MIT license.
/**
 * The two speech stages, faked — which is what makes level 1 TEXT-DRIVEN.
 *
 * A voice agent's input is paced PCM, and the plan this implements is explicit
 * that the audio boundary is where the two eval levels split. Level 1 asks the
 * questions that live ABOVE it — tool choice, tool arguments, tool ORDER, step
 * count, what the agent said, history handling — so it runs the real pipeline
 * transport, the real LLM loop, the real tool executor and the real session
 * event stream, with STT and TTS replaced by these.
 *
 * **This is emphatically NOT level 2.** Endpointing, splits and merges,
 * barge-in and the `speech.started`/`reply.cancelled` ratio are all properties
 * of the boundary these fakes remove, and no assertion driven through them can
 * say anything about one. A committed transcript arrives because the harness
 * said so, at the instant it said so.
 *
 * Registered through `registerSttKind`/`registerTtsKind` (on
 * `@alexkroman1/aai-runtime`) rather than handed in as pre-resolved openers,
 * because that seam's own doc gives the reason: a fake that goes through the
 * registry resolves exactly like a real provider, its env var included, and
 * production code only ever sees descriptors.
 *
 * @module
 */

// The two DESCRIPTOR types stay on the authoring subpaths: they are what a
// factory returns, which is an agent author's concern. The opener contract the
// fakes implement is re-exported from this package's root barrel, beside the
// two register calls — reached here by relative path because a package may not
// import itself by name.
import type {
  SttEvents,
  SttOpener,
  SttOpenOptions,
  SttSession,
  TtsEvents,
  TtsOpener,
  TtsOpenOptions,
  TtsSession,
} from "@alexkroman1/aai/host-internal";
import type { SttProvider } from "@alexkroman1/aai/stt";
import type { TtsProvider } from "@alexkroman1/aai/tts";
import { createNanoEvents } from "nanoevents";
import { registerSttKind, registerTtsKind } from "../providers/resolve.ts";

/** The env var the fake stages resolve their (unused) credential from. */
export const STUB_SPEECH_API_KEY_ENV = "AAI_EVAL_FAKE_SPEECH_KEY";

/** One open fake STT stream, plus the two edges a case drives. */
export type StubSttSession = SttSession & {
  /** Emit an interim transcript. */
  partial(text: string): void;
  /** Emit the committed turn — the cue the pipeline runs the LLM on. */
  commit(text: string): void;
};

/** One open fake TTS stream, plus what it captured. */
export type StubTtsSession = TtsSession & {
  /** Every text chunk the pipeline handed to TTS, in order. */
  readonly spoken: readonly string[];
};

/**
 * Both fake stages, registered, with the handles a case needs.
 *
 * `release()` unregisters the kinds. Kinds are UNIQUE per install (the registry
 * is process-global and a session may outlive the case that opened it), so two
 * concurrent eval sessions cannot serve each other's transcripts.
 */
export type StubSpeechProviders = {
  readonly stt: SttProvider;
  readonly tts: TtsProvider;
  /** Merge into the runtime env: the fake stages resolve a credential too. */
  readonly env: Record<string, string>;
  /** The most recently opened STT stream, once the session has started. */
  sttSession(): StubSttSession | undefined;
  /** The most recently opened TTS stream, once the session has started. */
  ttsSession(): StubTtsSession | undefined;
  release(): void;
};

let installs = 0;

/** One fake STT stage, and the last stream it opened. */
export function createStubSttOpener(name: string): SttOpener & {
  last(): StubSttSession | undefined;
} {
  let last: StubSttSession | undefined;
  return {
    name,
    last: () => last,
    async open(_opts: SttOpenOptions): Promise<SttSession> {
      const events = createNanoEvents<SttEvents>();
      last = {
        sendAudio() {
          // Level 1 sends no audio. A real client's frames would arrive here.
        },
        on: (event, fn) => events.on(event, fn),
        close: async () => undefined,
        partial(text) {
          events.emit("partial", text);
        },
        commit(text) {
          events.emit("final", text);
        },
      };
      return last;
    },
  };
}

/** One fake TTS stage, and the last stream it opened. */
export function createStubTtsOpener(name: string): TtsOpener & {
  last(): StubTtsSession | undefined;
} {
  let last: StubTtsSession | undefined;
  return {
    name,
    last: () => last,
    async open(_opts: TtsOpenOptions): Promise<TtsSession> {
      const events = createNanoEvents<TtsEvents>();
      const spoken: string[] = [];
      last = {
        spoken,
        sendText(text) {
          spoken.push(text);
        },
        /**
         * Ends the turn, and deliberately forwards NO AUDIO.
         *
         * A chunk of silence per flush looks harmless and is not: the pipeline
         * estimates playback open-loop from forwarded audio plus a grace, so
         * for several hundred ms after a reply the agent is modelled as HOLDING
         * THE FLOOR — and a harness that commits the next utterance in the same
         * tick therefore commits it *during* speech, which is a barge-in.
         * Measured on the first draft of this file: every case after the
         * greeting recorded a spurious `reply.cancelled`, and `say()` settled on
         * it instead of on the reply to what was said. Forwarding nothing means
         * the pacer never believes audio is in flight, so a level-1 turn is
         * never an interruption. Level 2 is where a real playout clock belongs.
         */
        flush() {
          events.emit("done");
        },
        cancel() {
          events.emit("done");
        },
        on: (event, fn) => events.on(event, fn),
        close: async () => undefined,
      };
      return last;
    },
  };
}

/** Register both fake stages. Call `release()` when the case is done. */
export function installStubSpeechProviders(): StubSpeechProviders {
  installs += 1;
  const sttKind = `aai-eval-stt-${installs}`;
  const ttsKind = `aai-eval-tts-${installs}`;
  const stt = createStubSttOpener(sttKind);
  const tts = createStubTtsOpener(ttsKind);
  const undoStt = registerSttKind(sttKind, {
    envVar: STUB_SPEECH_API_KEY_ENV,
    open: () => stt,
  });
  const undoTts = registerTtsKind(ttsKind, {
    envVar: STUB_SPEECH_API_KEY_ENV,
    open: () => tts,
  });

  return {
    stt: { kind: sttKind, options: {} },
    tts: { kind: ttsKind, options: {} },
    env: { [STUB_SPEECH_API_KEY_ENV]: "eval-fake-speech" },
    sttSession: () => stt.last(),
    ttsSession: () => tts.last(),
    release() {
      undoStt();
      undoTts();
    },
  };
}
