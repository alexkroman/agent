// Copyright 2025 the AAI authors. MIT license.

import { AssemblyAI, type StreamingTranscriber } from "assemblyai";
import { createNanoEvents, type Emitter } from "nanoevents";
import {
  ASSEMBLYAI_API_KEY_ENV,
  type AssemblyAIOptions,
} from "../../../sdk/providers/stt/assemblyai.ts";
import {
  makeSttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
} from "../../../sdk/providers.ts";
import { closeOnAbort, connectOrThrow, createSessionShell, requireApiKey } from "../_utils.ts";

export interface AssemblyAISession extends SttSession {
  /** @internal Test-only: exposes the underlying SDK transcriber for fixture replay. */
  readonly _transcriber: StreamingTranscriber;
}

function resolveSpeechModel(model: string): string {
  // Normalize friendly/legacy aliases to the AssemblyAI streaming enum values.
  // The API rejects "universal-3.5-pro" (dot) and "u3pro-rt"; map both.
  if (model === "u3pro-rt") return "u3-rt-pro";
  if (model === "universal-3.5-pro") return "universal-3-5-pro";
  return model;
}

/**
 * `agent_context` is accepted only by the Universal-3.5 Pro streaming
 * family — connection-time is rejected and mid-stream updates are stripped
 * (with a server warning) on every other model. Names cover both the
 * dot- and dash-spelled literals plus the SDK's rt-pro aliases.
 */
const UNIVERSAL_3_5_PRO_MODELS: ReadonlySet<string> = new Set([
  "universal-3-5-pro",
  "u3-rt-pro",
  "u3-rt-pro-beta-1",
  "u3-rt-agent",
]);

function supportsAgentContext(resolvedSpeechModel: string): boolean {
  return UNIVERSAL_3_5_PRO_MODELS.has(resolvedSpeechModel);
}

/** AssemblyAI's `agent_context` cap. Values longer than this are truncated. */
const AGENT_CONTEXT_MAX_CHARS = 1750;

/** Cap `text` at {@link AGENT_CONTEXT_MAX_CHARS}; `undefined` for empty/whitespace-only text. */
function normalizeAgentContext(text: string): string | undefined {
  if (text.trim().length === 0) return;
  return text.length > AGENT_CONTEXT_MAX_CHARS ? text.slice(0, AGENT_CONTEXT_MAX_CHARS) : text;
}

export function openAssemblyAI(opts: AssemblyAIOptions = {}): SttOpener {
  return {
    name: "assemblyai",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const apiKey = requireApiKey(
        openOpts.apiKey,
        ASSEMBLYAI_API_KEY_ENV,
        "AssemblyAI STT",
        (msg) => makeSttError("stt_auth_failed", msg),
      );

      const client = new AssemblyAI({ apiKey });
      const speechModel = resolveSpeechModel(opts.model ?? "universal-3-5-pro");
      const agentContextCapable = supportsAgentContext(speechModel);
      const initialAgentContext = agentContextCapable
        ? normalizeAgentContext(openOpts.agentContext ?? "")
        : undefined;
      // Voice focus (noise suppression); defaults to near-field. "off"/"" disables.
      const requestedVoiceFocus = opts.voiceFocus ?? "near-field";
      const voiceFocus = requestedVoiceFocus === "off" ? "" : requestedVoiceFocus;
      // Build params as a loose record and cast once: the SDK's param type is a
      // strict string-literal union and, under exactOptionalPropertyTypes, does
      // not accept our widened `string` option types via conditional spreads.
      const transcriberParams: Record<string, unknown> = {
        sampleRate: openOpts.sampleRate,
        speechModel,
      };
      if (openOpts.sttPrompt) transcriberParams.prompt = openOpts.sttPrompt;
      if (initialAgentContext !== undefined) {
        transcriberParams.agentContext = initialAgentContext;
      }
      if (voiceFocus) transcriberParams.voiceFocus = voiceFocus;
      const transcriber = client.streaming.transcriber(
        transcriberParams as Parameters<typeof client.streaming.transcriber>[0],
      );

      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      const shell = createSessionShell({
        makeStreamError: (msg) => makeSttError("stt_stream_error", msg),
        emitError: (err) => emitter.emit("error", err),
        teardown: () => transcriber.close(),
      });

      transcriber.on("turn", (event) => {
        if (shell.isClosed()) return;
        const text = event.transcript ?? "";
        if (text.length === 0) return;
        emitter.emit(event.end_of_turn ? "final" : "partial", text);
      });

      transcriber.on("error", (err) => shell.onSocketError(err));
      transcriber.on("close", (code) => shell.onSocketClose(code));

      await connectOrThrow(
        "AssemblyAI STT",
        (msg) => makeSttError("stt_connect_failed", msg),
        () => transcriber.connect(),
      );

      closeOnAbort(openOpts.signal, shell.close);

      // AssemblyAI streaming requires each audio frame to be 50–1000 ms, but
      // telephony clients (e.g. the tau2 harness) stream standard 20 ms RTP
      // frames. Coalesce inbound PCM into ~100 ms frames (capped at 1000 ms)
      // before forwarding; a sub-100 ms remainder is carried to the next call.
      // A fixed accumulator (vs. reallocating a merged carry per chunk) keeps
      // per-chunk cost to one `set` copy of the new samples.
      const rate = openOpts.sampleRate;
      const minFrameSamples = Math.max(1, Math.round(rate * 0.1)); // 100 ms
      const maxFrameSamples = Math.max(minFrameSamples, Math.round(rate)); // 1000 ms
      const minSendSamples = Math.max(1, Math.round(rate * 0.05)); // 50 ms floor
      const acc = new Int16Array(maxFrameSamples);
      let accLen = 0;
      const sendFrame = (): void => {
        // `slice` copies just the sent bytes; the accumulator is reused.
        transcriber.sendAudio(acc.buffer.slice(0, accLen * 2));
        accLen = 0;
      };
      const flushTail = (): void => {
        if (accLen >= minSendSamples && !shell.isClosed()) {
          try {
            sendFrame();
          } catch {
            // socket already closing; nothing to flush
          }
        }
        accLen = 0;
      };

      const session: AssemblyAISession = {
        sendAudio(pcm: Int16Array) {
          if (shell.isClosed()) return;
          // Copy into the accumulator (the caller may reuse `pcm`'s backing
          // buffer), flushing a frame whenever it fills or once the whole
          // chunk is buffered and ≥ the 100 ms minimum has accumulated.
          let offset = 0;
          while (offset < pcm.length) {
            const take = Math.min(maxFrameSamples - accLen, pcm.length - offset);
            acc.set(pcm.subarray(offset, offset + take), accLen);
            accLen += take;
            offset += take;
            if (
              accLen === maxFrameSamples ||
              (offset === pcm.length && accLen >= minFrameSamples)
            ) {
              sendFrame();
            }
          }
        },
        on(event, fn) {
          return emitter.on(event, fn);
        },
        close: () => {
          flushTail();
          return shell.close();
        },
        updateAgentContext(text: string) {
          if (!agentContextCapable || shell.isClosed()) return;
          const normalized = normalizeAgentContext(text);
          if (normalized === undefined) return;
          // NOTE: the wire/update-message field is snake_case (`agent_context`),
          // unlike the connect-time constructor param (`agentContext`).
          transcriber.updateConfiguration({ agent_context: normalized });
        },
        _transcriber: transcriber,
      };

      return session;
    },
  };
}
