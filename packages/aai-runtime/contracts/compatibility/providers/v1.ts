// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-1 TEMPLATE: `aai-runtime:providers` — a custom speech provider.
 *
 * This is the starter as it was written at epoch 1: a matched STT + TTS stage
 * pair for a vendor the SDK does not ship, registered as KINDS so the runtime
 * resolves them exactly like a shipped provider (env var included) and the rest
 * of your host only ever sees descriptors. Copy the file into your host, edit
 * the points marked `// ←`, and call {@link installCustomSpeech} where you
 * build the agent's config.
 *
 * **FROZEN.** This file must keep compiling against current source for as long
 * as epoch 1 is supported — a compile error here is the finding, not something
 * to edit away. The way to change this API is a NEW epoch carrying a new
 * template, never an edit to this one. (Imports are relative because the
 * package cannot resolve itself by name; in your copy they are
 * `@alexkroman1/aai-runtime`.)
 *
 * **What to change:** the two kinds, the env var, the endpoints, every field
 * name inside `decodeSttFrame` / `decodeTtsFrame`, and {@link VendorConnect} —
 * which is the only part that touches your vendor.
 *
 * **What not to change:** the emit discipline. A decode path never throws, a
 * cancelled turn never emits a second `done`, and audio is forwarded as
 * PCM16 at the sample rate you were handed in `open`.
 */

// Descriptor types stay on the authoring subpaths: a descriptor is what an
// agent config carries. The opener contract below is the host's half.
import type { SttProvider } from "@alexkroman1/aai/stt";
import type { TtsProvider } from "@alexkroman1/aai/tts";
import { isRecord, safeJsonParse } from "@alexkroman1/aai/utils";
import { createNanoEvents } from "nanoevents";
import {
  type OpenerRegistryEntry,
  registerSttKind,
  registerTtsKind,
  type SttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
  type SttTurnMeta,
  type TtsError,
  type TtsEvents,
  type TtsOpener,
  type TtsOpenOptions,
  type TtsSession,
  type TtsWordTiming,
} from "../../../runtime-barrel.ts";

// ---------------------------------------------------------------------------
// Edit points
// ---------------------------------------------------------------------------

/** The kind an STT descriptor names to select this stage. */
export const CUSTOM_STT_KIND = "custom-stt"; // ← name it after your vendor
/** The kind a TTS descriptor names to select this stage. */
export const CUSTOM_TTS_KIND = "custom-tts"; // ←

/**
 * The credential the runtime resolves BEFORE opening either stage, and hands to
 * `open` as `opts.apiKey`.
 *
 * A registered kind needs one even if the stage authenticates some other way:
 * the preflight that checks an agent's credentials before it starts reads
 * exactly this name, and an agent whose env lacks it fails to start.
 */
export const CUSTOM_SPEECH_API_KEY_ENV = "CUSTOM_SPEECH_API_KEY"; // ←

/** Where each stage connects. */
export const CUSTOM_STT_URL = "wss://stt.your-vendor.example/v1/stream"; // ←
export const CUSTOM_TTS_URL = "wss://tts.your-vendor.example/v1/stream"; // ←

/** The voice used when the agent's descriptor names none. */
export const CUSTOM_DEFAULT_VOICE = "default"; // ←

// ---------------------------------------------------------------------------
// The one seam that touches your vendor
// ---------------------------------------------------------------------------

/** One open duplex connection to your vendor. */
export type VendorStream = {
  /** Send one frame upstream — JSON text, or raw audio bytes. */
  send(frame: string | Uint8Array): void;
  /** Register the downstream reader. Called once, right after connecting. */
  onFrame(fn: (raw: string) => void): void;
  close(): Promise<void>;
};

/**
 * Open one. ← Implement this over `ws` (or your vendor's own SDK) and hand it
 * to {@link installCustomSpeech}.
 *
 * Two obligations, both of which the shipped adapters under `providers/stt/`
 * keep: abort the connect on `signal`, and never let the socket's `message`
 * handler throw — an exception out of it is an uncaughtException that takes
 * down every session in the process, not just this one.
 */
export type VendorConnect = (opts: {
  url: string;
  apiKey: string;
  /** Hz. STT: what the client captures at. TTS: what you must synthesize at. */
  sampleRate: number;
  /** Optional biasing text the agent declared; ignore it if your vendor has none. */
  prompt: string | undefined;
  signal: AbortSignal;
}) => Promise<VendorStream>;

// ---------------------------------------------------------------------------
// Wire decoding — every field name below is your vendor's
// ---------------------------------------------------------------------------

type SttFrame =
  | { kind: "transcript"; text: string; final: boolean; confidence: number | null }
  | { kind: "error"; message: string };

/** One inbound STT frame, or null for anything not to act on. */
function decodeSttFrame(raw: string): SttFrame | null {
  // No schema library, deliberately: this runs for every frame of every live
  // call. Probe field by field and return a value on every path — an
  // unrecognized frame is null, never a throw.
  const frame = safeJsonParse(raw);
  if (!isRecord(frame)) return null;
  const failure = frame.error; // ← your vendor's error field
  if (typeof failure === "string") return { kind: "error", message: failure };
  const text = frame.text; // ← your vendor's transcript field
  if (typeof text !== "string" || text === "") return null;
  // ← your vendor's end-of-turn confidence, if it reports one. Omit the field
  // rather than substituting a number: consumers read `undefined` as "no
  // opinion" and a fabricated 0 reads as "the turn is definitely not over".
  const confidence = frame.end_of_turn_confidence;
  return {
    kind: "transcript",
    text,
    final: frame.is_final === true, // ← your vendor's final flag
    confidence: typeof confidence === "number" ? confidence : null,
  };
}

type TtsFrame =
  | { kind: "audio"; pcm: Int16Array }
  | { kind: "words"; words: TtsWordTiming[] }
  | { kind: "done" }
  | { kind: "error"; message: string };

/** ← your vendor's per-word timings. Delete this if it reports none. */
function decodeWords(value: unknown): TtsWordTiming[] | null {
  if (!Array.isArray(value)) return null;
  const words: TtsWordTiming[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { word, start_ms: startMs, end_ms: endMs } = entry;
    if (typeof word !== "string" || typeof startMs !== "number" || typeof endMs !== "number") {
      continue;
    }
    // Offsets are ms into THIS TURN's audio — rebase here if your vendor
    // reports a per-socket clock, or the transport's audio accounting drifts.
    words.push({ text: word, startMs, endMs });
  }
  return words.length === 0 ? null : words;
}

/** One inbound TTS frame, or null for anything not to act on. */
function decodeTtsFrame(raw: string): TtsFrame | null {
  const frame = safeJsonParse(raw);
  if (!isRecord(frame)) return null;
  const failure = frame.error; // ←
  if (typeof failure === "string") return { kind: "error", message: failure };
  if (frame.done === true) return { kind: "done" }; // ← "synthesis drained"
  const words = decodeWords(frame.words); // ←
  if (words !== null) return { kind: "words", words };
  const audio = frame.audio; // ← base64 PCM16, little-endian
  if (typeof audio !== "string") return null;
  return { kind: "audio", pcm: pcm16FromBase64(audio) };
}

/** Base64 PCM16LE to samples. Copied, not viewed: a base64 payload's decoded
 * offset need not be 2-byte aligned, and an `Int16Array` view over an odd one
 * throws. */
function pcm16FromBase64(base64: string): Int16Array {
  const bytes = Buffer.from(base64, "base64");
  const samples = new Int16Array(bytes.byteLength >> 1);
  for (let i = 0; i < samples.length; i += 1) samples[i] = bytes.readInt16LE(i * 2);
  return samples;
}

/** Samples to PCM16LE bytes — a zero-copy view, so do not retain it upstream. */
function pcm16ToBytes(pcm: Int16Array): Uint8Array {
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

function sttError(code: SttError["code"], message: string): SttError {
  return Object.assign(new Error(message), { code });
}

function ttsError(code: TtsError["code"], message: string): TtsError {
  return Object.assign(new Error(message), { code });
}

// ---------------------------------------------------------------------------
// The two stages
// ---------------------------------------------------------------------------

/** The STT stage: caller audio in, transcripts out. */
export function createCustomSttOpener(connect: VendorConnect): SttOpener {
  return {
    name: CUSTOM_STT_KIND,
    open: async (opts: SttOpenOptions): Promise<SttSession> => {
      const events = createNanoEvents<SttEvents>();
      const stream = await connect({
        url: CUSTOM_STT_URL,
        apiKey: opts.apiKey,
        sampleRate: opts.sampleRate,
        prompt: opts.sttPrompt,
        signal: opts.signal,
      });
      stream.onFrame((raw) => {
        const frame = decodeSttFrame(raw);
        if (frame === null) return;
        if (frame.kind === "error") {
          // Terminal: the session ends after this. Emit it rather than
          // throwing, and do not emit transcripts afterwards.
          events.emit("error", sttError("stt_stream_error", frame.message));
          return;
        }
        const meta: SttTurnMeta | undefined =
          frame.confidence === null ? undefined : { endOfTurnConfidence: frame.confidence };
        // `final` is the cue the pipeline runs the LLM on, `partial` drives
        // barge-in detection. Emitting a partial as a final commits a turn the
        // caller has not finished speaking.
        if (frame.final) events.emit("final", frame.text, meta);
        else events.emit("partial", frame.text, meta);
      });
      return {
        sendAudio: (pcm) => stream.send(pcm16ToBytes(pcm)),
        // ← delete this method if your vendor cannot be told what the agent
        // just said. Callers invoke it with `?.()`, so absence is legal.
        updateAgentContext: (text) => stream.send(JSON.stringify({ agent_context: text })),
        on: (event, fn) => events.on(event, fn),
        close: () => stream.close(),
      };
    },
  };
}

/** The TTS stage: reply text in, PCM16 out. */
export function createCustomTtsOpener(connect: VendorConnect, voice: string): TtsOpener {
  return {
    name: CUSTOM_TTS_KIND,
    open: async (opts: TtsOpenOptions): Promise<TtsSession> => {
      const events = createNanoEvents<TtsEvents>();
      const stream = await connect({
        url: CUSTOM_TTS_URL,
        apiKey: opts.apiKey,
        sampleRate: opts.sampleRate,
        prompt: undefined,
        signal: opts.signal,
      });
      // A `done` belonging to a cancelled turn must not reach the transport:
      // the event carries no turn id, so it would end the NEXT turn's
      // flush-wait early. Cleared by the first text of the next turn.
      let cancelled = false;
      stream.onFrame((raw) => {
        const frame = decodeTtsFrame(raw);
        if (frame === null) return;
        if (frame.kind === "audio") events.emit("audio", frame.pcm);
        else if (frame.kind === "words") events.emit("words", frame.words);
        else if (frame.kind === "error") events.emit("error", ttsError("tts_stream_error", raw));
        else if (!cancelled) events.emit("done");
      });
      return {
        sendText: (text) => {
          cancelled = false;
          stream.send(JSON.stringify({ text, voice })); // ←
        },
        // "No more text this turn". `done` follows from the vendor once
        // synthesis has drained — do not emit it here.
        //
        // If you are adapting this into a stage that produces NO audio at all
        // (a text front door, a fake for tests), forward nothing rather than
        // silence: the transport estimates playback open-loop from the audio
        // you forward, so silent frames model the agent as still holding the
        // floor and the next user turn arrives as a barge-in.
        flush: () => stream.send(JSON.stringify({ flush: true })), // ←
        cancel: () => {
          cancelled = true;
          stream.send(JSON.stringify({ cancel: true })); // ←
          // Synchronously, and exactly once: barge-in is what this is for.
          events.emit("done");
        },
        on: (event, fn) => events.on(event, fn),
        close: () => stream.close(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * `open` is handed the DESCRIPTOR, whose `options` are a serializable record —
 * the agent config crossed a wire to get here — so read your own options back
 * out with a narrowing.
 */
function voiceOf(options: Record<string, unknown>): string {
  const voice = options.voice;
  return typeof voice === "string" && voice !== "" ? voice : CUSTOM_DEFAULT_VOICE;
}

export function customSttEntry(connect: VendorConnect): OpenerRegistryEntry<SttOpener> {
  return { envVar: CUSTOM_SPEECH_API_KEY_ENV, open: () => createCustomSttOpener(connect) };
}

export function customTtsEntry(connect: VendorConnect): OpenerRegistryEntry<TtsOpener> {
  return {
    envVar: CUSTOM_SPEECH_API_KEY_ENV,
    open: (descriptor) => createCustomTtsOpener(connect, voiceOf(descriptor.options)),
  };
}

/** Both stages, the descriptors that select them, and the env they resolve. */
export type CustomSpeechStages = {
  readonly stt: SttProvider;
  readonly tts: TtsProvider;
  /** Merge into the runtime's env. */
  readonly env: Record<string, string>;
  /** Unregister both kinds. */
  release(): void;
};

/**
 * Install both stages and hand back what an agent config names.
 *
 * `suffix` keeps the two kinds unique per install: the registry is
 * process-global and a session can outlive whatever installed it, so two
 * concurrent installs sharing a kind serve each other's audio. Call `release()`
 * when the last session using them is gone — an unregister is not optional.
 */
export function installCustomSpeech(
  connect: VendorConnect,
  suffix: string,
  apiKey: string,
): CustomSpeechStages {
  const sttKind = `${CUSTOM_STT_KIND}-${suffix}`;
  const ttsKind = `${CUSTOM_TTS_KIND}-${suffix}`;
  const undoStt = registerSttKind(sttKind, customSttEntry(connect));
  const undoTts = registerTtsKind(ttsKind, customTtsEntry(connect));
  return {
    stt: { kind: sttKind, options: {} },
    tts: { kind: ttsKind, options: { voice: CUSTOM_DEFAULT_VOICE } },
    env: { [CUSTOM_SPEECH_API_KEY_ENV]: apiKey },
    release: () => {
      undoStt();
      undoTts();
    },
  };
}
