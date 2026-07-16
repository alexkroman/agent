// Copyright 2026 the AAI authors. MIT license.
// Provider lifecycle for the pipeline transport: opening the STT and TTS
// sessions, adopting them as they land, routing their events to the turn
// orchestrator (pipeline-transport.ts), and tearing them down again.

import type { SessionErrorCode } from "../../sdk/protocol.ts";
import type {
  SttError,
  SttOpener,
  SttSession,
  TtsError,
  TtsOpener,
  TtsSession,
  Unsubscribe,
} from "../../sdk/providers.ts";
import { errorMessage } from "../../sdk/utils.ts";
import type { Logger } from "../runtime-config.ts";

/** Configuration for {@link createPipelineProviderSessions}. */
export interface PipelineProviderOptions {
  /** Unique session identifier (log context). */
  sid: string;
  /** STT opener (resolved from an SttProvider descriptor). */
  stt: SttOpener;
  /** TTS opener (resolved from a TtsProvider descriptor). */
  tts: TtsOpener;
  /** Provider-specific API keys. */
  providerKeys: { stt: string; tts: string };
  /** STT audio input sample rate (PCM16, Hz). */
  sttSampleRate: number;
  /** TTS audio output sample rate (PCM16, Hz). */
  ttsSampleRate: number;
  /** Optional STT prompt injected via SttOpenOptions.sttPrompt. */
  sttPrompt?: string | undefined;
  /** Agent greeting, seeded as connect-time STT agent context. */
  greeting?: string | undefined;
  /** Session-scoped abort signal — a session torn down mid-open closes late arrivals. */
  signal: AbortSignal;
  /** Provider event handlers, implemented by the turn orchestrator. */
  handlers: {
    onSttPartial(text: string): void;
    onSttFinal(text: string, endOfTurnConfidence?: number): void;
    onSttError(err: SttError): void;
    onTtsError(err: TtsError): void;
    onTtsAudio(pcm: Int16Array): void;
  };
  /** Fires the moment TTS is live — lets the greeting start without waiting on STT. */
  onAudioReady: () => void;
  emitError: (code: SessionErrorCode, message: string) => void;
  log: Logger;
}

/** Handle to the pipeline's provider pair, live once {@link open} resolves. */
export interface PipelineProviderSessions {
  /** Adopted STT session, or null before adoption / after a failed open. */
  readonly stt: SttSession | null;
  /** Adopted TTS session, or null before adoption / after a failed open. */
  readonly tts: TtsSession | null;
  /**
   * Open both sides concurrently; each side goes live as soon as it lands.
   * Resolves "failed" when either side failed to open and the session wasn't
   * aborted mid-open — the caller decides how to tear down.
   */
  open(): Promise<"ok" | "failed">;
  /** Unsubscribe all provider event listeners (stop path). */
  unsubscribe(): void;
  /** Best-effort concurrent close of both adopted sessions; rejections swallowed. */
  close(): Promise<void>;
}

/** Create the STT/TTS provider pair for one pipeline session. */
export function createPipelineProviderSessions(
  opts: PipelineProviderOptions,
): PipelineProviderSessions {
  const { handlers, log } = opts;
  let sttSession: SttSession | null = null;
  let ttsSession: TtsSession | null = null;
  const sttSubs: Unsubscribe[] = [];
  const ttsSubs: Unsubscribe[] = [];

  function reportOpenRejection(which: "stt" | "tts", reason: unknown): void {
    const msg = errorMessage(reason);
    log.error(`${which === "stt" ? "STT" : "TTS"} open failed`, {
      error: msg,
      sid: opts.sid,
    });
    opts.emitError(which, msg);
  }

  function adoptStt(session: SttSession): void {
    sttSession = session;
    sttSubs.push(session.on("partial", (text) => handlers.onSttPartial(text)));
    sttSubs.push(
      session.on("final", (text, endOfTurnConfidence) =>
        handlers.onSttFinal(text, endOfTurnConfidence),
      ),
    );
    sttSubs.push(session.on("error", (err) => handlers.onSttError(err)));
  }

  function adoptTts(session: TtsSession): void {
    ttsSession = session;
    ttsSubs.push(session.on("audio", (pcm) => handlers.onTtsAudio(pcm)));
    // `done` is intentionally NOT subscribed persistently — flushTtsAndWait
    // attaches a one-shot listener per-turn to avoid double-firing audio_done.
    ttsSubs.push(session.on("error", (err) => handlers.onTtsError(err)));
  }

  /**
   * Open one provider side and adopt it the moment it lands (closing it
   * instead when the session aborted mid-open). `onAdopted` runs right after
   * a live adoption — this is what lets the greeting start on TTS without
   * waiting for STT.
   */
  async function openSide<S extends { close(): Promise<void> }>(
    which: "stt" | "tts",
    open: () => Promise<S>,
    adopt: (session: S) => void,
    onAdopted?: () => void,
  ): Promise<"ok" | "failed"> {
    let session: S;
    try {
      session = await open();
    } catch (reason) {
      reportOpenRejection(which, reason);
      return "failed";
    }
    if (opts.signal.aborted) {
      await session.close().catch(() => undefined);
      return "ok";
    }
    adopt(session);
    onAdopted?.();
    return "ok";
  }

  // STT and TTS open concurrently and each side goes live as soon as it
  // lands, so first greeting audio isn't gated on the slower connect
  // (usually STT). The trade: if the other side then fails, the caller's
  // teardown cuts a just-started greeting short instead of never starting it.
  async function open(): Promise<"ok" | "failed"> {
    const [sttOutcome, ttsOutcome] = await Promise.all([
      openSide(
        "stt",
        () =>
          opts.stt.open({
            sampleRate: opts.sttSampleRate,
            apiKey: opts.providerKeys.stt,
            sttPrompt: opts.sttPrompt,
            // Seed the agent's opening line as connect-time context (e.g.
            // AssemblyAI `agent_context`) — providers that don't support it,
            // or whose model doesn't qualify, ignore this field.
            agentContext: opts.greeting,
            signal: opts.signal,
          }),
        adoptStt,
      ),
      openSide(
        "tts",
        () =>
          opts.tts.open({
            sampleRate: opts.ttsSampleRate,
            apiKey: opts.providerKeys.tts,
            signal: opts.signal,
          }),
        adoptTts,
        opts.onAudioReady,
      ),
    ]);

    if (!opts.signal.aborted && (sttOutcome === "failed" || ttsOutcome === "failed")) {
      return "failed";
    }
    return "ok";
  }

  return {
    get stt() {
      return sttSession;
    },
    get tts() {
      return ttsSession;
    },
    open,
    unsubscribe(): void {
      for (const off of sttSubs) off();
      for (const off of ttsSubs) off();
      sttSubs.length = 0;
      ttsSubs.length = 0;
    },
    async close(): Promise<void> {
      // Close both provider sockets concurrently; allSettled swallows
      // already-closed rejections.
      await Promise.allSettled([sttSession?.close(), ttsSession?.close()]);
    },
  };
}
