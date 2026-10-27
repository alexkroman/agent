// Copyright 2026 the AAI authors. MIT license.
/**
 * `useDictation` — speak into a text box: record a clip, have it transcribed,
 * hand the words to the page.
 *
 * Not a session. There is no agent on the other end and no socket: the clip
 * goes to AssemblyAI's dictation API in ONE request, through a `transcribe`
 * callback the page supplies — on the far side of which is a server holding
 * the key, calling `transcribeDictation` from `@alexkroman1/aai/experimental`.
 * The key never reaches the browser, which is why this hook takes a callback
 * rather than a credential.
 *
 * What it owns, because each is a way a hand-written mic button goes wrong:
 *
 * - **The recording indicator goes out.** Every way out — stop, cancel, the
 *   length cap, an unmount mid-recording — releases the microphone.
 * - **A late answer lands nowhere.** A transcription that settles after a
 *   cancel, a newer recording or an unmount is dropped, never typed into the
 *   box the user has moved on from.
 * - **The clip fits the endpoint.** Recording stops by itself at `maxSeconds`
 *   and is transcribed, rather than growing into a clip the service refuses
 *   whole.
 */

import { errorMessage } from "@alexkroman1/aai";
import { DICTATION_MAX_SECONDS, DICTATION_SAMPLE_RATE } from "@alexkroman1/aai/experimental";
import { createEpoch } from "@alexkroman1/aai/internal";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DictationRecorder } from "./audio/index.ts";

/**
 * Options for {@link useDictation}.
 *
 * @input
 */
export type UseDictationOptions = {
  /**
   * Turn one clip — a mono 16-bit WAV — into text. Called once per recording,
   * with a signal that aborts when the result would no longer be used. Usually
   * a `POST` to the page's own server, which forwards the clip to the
   * dictation API under its key. A rejection is shown as `error`.
   */
  transcribe: (audio: Blob, options: { signal: AbortSignal }) => Promise<string>;
  /**
   * The words, once a recording is transcribed. Not called for an empty
   * transcript (the user said nothing) or for a recording that was cancelled.
   */
  onText: (text: string) => void;
  /**
   * The longest recording, in seconds: it stops and is transcribed by itself
   * then. Defaults to the dictation API's own ceiling, 120.
   */
  maxSeconds?: number;
};

/**
 * What {@link useDictation} returns.
 *
 * @sealed
 * @public
 */
export type UseDictationResult = {
  /**
   * Where the hook is: `"idle"`, `"starting"` (asking for the microphone),
   * `"recording"` or `"transcribing"`.
   */
  phase: "idle" | "starting" | "recording" | "transcribing" | (string & {});
  /** Why the last recording produced no text, or `null`. Cleared by `start`. */
  error: string | null;
  /**
   * Whether this browser can record at all — a microphone API, an
   * `AudioContext` and audio worklets. A button should not render without it.
   */
  supported: boolean;
  /** Ask for the microphone and start recording. Ignored unless idle. */
  start: () => void;
  /** Stop recording and transcribe what was said. Ignored unless recording. */
  stop: () => void;
  /** Throw the recording (or the transcription in flight) away. */
  cancel: () => void;
  /** `start` when idle, `stop` when recording — one button. */
  toggle: () => void;
};

/** How a recorder is opened; the real one loads the audio chunk on first use. */
export type OpenDictationRecorder = (opts: {
  sampleRate: number;
  maxSeconds: number;
}) => Promise<DictationRecorder>;

const openRecorder: OpenDictationRecorder = async (opts) => {
  const [audio, captureWorkletSrc] = await Promise.all([
    import("./audio/index.ts"),
    import("./worklets/capture-processor.ts").then((m) => m.default),
  ]);
  return audio.openDictationRecorder({ ...opts, captureWorkletSrc });
};

/** Stop `rec` and transcribe the clip; `""` when aborted before the request. */
async function transcribeRecording(
  rec: DictationRecorder,
  signal: AbortSignal,
  transcribe: UseDictationOptions["transcribe"],
): Promise<string> {
  const wav = await rec.stop();
  if (signal.aborted) return "";
  return (await transcribe(new Blob([wav], { type: "audio/wav" }), { signal })).trim();
}

function browserCanRecord(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined"
  );
}

/**
 * Record what the user says and hand it back as text — a microphone button
 * for a text box.
 *
 * @example
 * ```tsx
 * import { useDictation } from "@alexkroman1/aai-ui";
 * import { useState } from "react";
 *
 * export function SpokenNote() {
 *   const [draft, setDraft] = useState("");
 *   const dictation = useDictation({
 *     transcribe: async (audio, { signal }) => {
 *       const res = await fetch("api/dictation", { method: "POST", body: audio, signal });
 *       return ((await res.json()) as { text: string }).text;
 *     },
 *     onText: (text) => setDraft((d) => (d ? `${d} ${text}` : text)),
 *   });
 *   return (
 *     <div>
 *       <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
 *       <button type="button" onClick={dictation.toggle}>
 *         {dictation.phase === "recording" ? "Stop" : "Speak"}
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 *
 * @public
 */
export function useDictation(options: UseDictationOptions): UseDictationResult {
  return useDictationWith(options, openRecorder);
}

/**
 * {@link useDictation} over an injected recorder — the seam the specs drive.
 * Not on the barrel.
 */
export function useDictationWith(
  options: UseDictationOptions,
  open: OpenDictationRecorder,
): UseDictationResult {
  const [phase, setPhase] = useState<UseDictationResult["phase"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const supported = useMemo(browserCanRecord, []);

  // Read per call, so an inline `transcribe`/`onText` re-arms nothing.
  const latest = useRef(options);
  latest.current = options;
  const openRef = useRef(open);
  openRef.current = open;

  // One generation per recording: everything that settles late checks it.
  const epoch = useRef(createEpoch()).current;
  const phaseRef = useRef<UseDictationResult["phase"]>("idle");
  const recorder = useRef<DictationRecorder | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const cap = useRef<ReturnType<typeof setTimeout> | null>(null);

  const move = useCallback((next: UseDictationResult["phase"]) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const clearCap = useCallback(() => {
    if (cap.current !== null) clearTimeout(cap.current);
    cap.current = null;
  }, []);

  /** Drop whatever is running, releasing the microphone. Leaves `phase` alone. */
  const abandon = useCallback(() => {
    epoch.bump();
    clearCap();
    inflight.current?.abort();
    inflight.current = null;
    const rec = recorder.current;
    recorder.current = null;
    void rec?.cancel();
  }, [epoch, clearCap]);

  const stop = useCallback(() => {
    const rec = recorder.current;
    if (phaseRef.current !== "recording" || !rec) return;
    recorder.current = null;
    clearCap();
    move("transcribing");
    const gen = epoch.current();
    const controller = new AbortController();
    inflight.current = controller;
    // Every settle checks the generation: a cancel, a newer recording or an
    // unmount bumped it, and the answer then belongs to nobody.
    const settle = (): void => {
      inflight.current = null;
      move("idle");
    };
    transcribeRecording(rec, controller.signal, latest.current.transcribe).then(
      (text) => {
        if (!epoch.isCurrent(gen)) return;
        if (text) latest.current.onText(text);
        settle();
      },
      (err: unknown) => {
        if (!epoch.isCurrent(gen)) return;
        setError(errorMessage(err));
        settle();
      },
    );
  }, [epoch, clearCap, move]);

  const start = useCallback(() => {
    if (phaseRef.current !== "idle") return;
    setError(null);
    move("starting");
    const gen = epoch.current();
    const maxSeconds = latest.current.maxSeconds ?? DICTATION_MAX_SECONDS;
    void openRef
      .current({ sampleRate: DICTATION_SAMPLE_RATE, maxSeconds })
      .then((rec) => {
        if (!epoch.isCurrent(gen)) {
          void rec.cancel();
          return;
        }
        recorder.current = rec;
        move("recording");
        cap.current = setTimeout(stop, maxSeconds * 1000);
      })
      .catch((err: unknown) => {
        if (!epoch.isCurrent(gen)) return;
        setError(errorMessage(err));
        move("idle");
      });
  }, [epoch, move, stop]);

  const cancel = useCallback(() => {
    if (phaseRef.current === "idle") return;
    abandon();
    move("idle");
  }, [abandon, move]);

  const toggle = useCallback(() => {
    if (phaseRef.current === "idle") start();
    else if (phaseRef.current === "recording") stop();
  }, [start, stop]);

  // An unmount mid-recording releases the microphone.
  useEffect(() => abandon, [abandon]);

  return { phase, error, supported, start, stop, cancel, toggle };
}
