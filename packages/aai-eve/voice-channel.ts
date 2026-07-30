// Copyright 2026 the AAI authors. MIT license.
/**
 * `voiceChannel()` — real-time voice for eve agents, built from the aai
 * voice stack.
 *
 * Drop the returned channel into an eve app (`agent/channels/voice.ts`) and
 * every browser connection to its WebSocket route gets the full aai voice
 * session: raw PCM16 both ways on the aai client protocol (the `aai-ui`
 * browser client connects unchanged), the host-side STT/TTS provider
 * sessions, endpoint settling, barge-in, hold phrases, dead-air cover, and
 * server-paced audio. The *reply* comes from the eve agent: each committed
 * user utterance is sent into the eve session (`send`, conversation mode)
 * and the reply streams back off eve's durable event stream — see
 * `createEveTurnRunner` in `@alexkroman1/aai/runtime` for the event
 * mapping and `route-agent-handle.ts` for the route-API adaptation.
 *
 * The eve agent owns the brain: instructions (`instructions.md`), tools,
 * skills, history, and durability all live eve-side. This channel owns the
 * ears, mouth, and turn-taking. Accordingly there is no `systemPrompt`
 * option here, tool calls surface to the browser as observability only
 * (`tool_call` / `tool_call_done` events), and barge-in maps to eve's
 * `cancelTurn`.
 */

import type { AgentConfig } from "@alexkroman1/aai/manifest";
import {
  consoleLogger,
  createEveTurnRunner,
  createPipelineTransport,
  createSessionCore,
  type Logger,
  type ResolvedOpener,
  resolveApiKey,
  resolveStt,
  resolveTts,
  type SessionCore,
  type SttOpener,
  type TransportCallbacks,
  type TtsOpener,
  wireSessionSocket,
} from "@alexkroman1/aai/runtime";
import type { SttProvider } from "@alexkroman1/aai/stt";
import type { TtsProvider } from "@alexkroman1/aai/tts";
import {
  type Channel,
  defineChannel,
  type WebSocketMessage,
  type WebSocketPeer,
  type WebSocketRouteHooks,
  WS,
} from "eve/channels";
import type { VoiceRouteArgsLike } from "./route-agent-handle.ts";
import { routeAgentHandle } from "./route-agent-handle.ts";
import { bridgePeerSocket, type PeerSocketBridge } from "./session-socket-bridge.ts";

/** Default sample rates, matching the aai platform defaults. */
const DEFAULT_STT_SAMPLE_RATE = 16_000;
const DEFAULT_TTS_SAMPLE_RATE = 24_000;

/** Options for {@link voiceChannel}. */
export interface VoiceChannelOptions {
  /** STT provider descriptor (from `@alexkroman1/aai/stt`). */
  stt: SttProvider;
  /** TTS provider descriptor (from `@alexkroman1/aai/tts`). */
  tts: TtsProvider;
  /**
   * Provider credentials keyed by env var name. Defaults to reading exactly
   * the two vars the resolved providers need from `process.env` — never the
   * whole environment.
   */
  env?: Record<string, string> | undefined;
  /** Display name sent to the browser client. Defaults to `"Voice Agent"`. */
  name?: string | undefined;
  /** Greeting spoken when a session connects. Empty/unset disables it. */
  greeting?: string | undefined;
  /** WebSocket route path. Defaults to `"/websocket"` (aai client default). */
  path?: string | undefined;
  /** STT audio input sample rate (PCM16, Hz). */
  sttSampleRate?: number | undefined;
  /** TTS audio output sample rate (PCM16, Hz). */
  ttsSampleRate?: number | undefined;
  /** Optional STT prompt (see aai's `SttOpenOptions.sttPrompt`). */
  sttPrompt?: string | undefined;
  // Voice tuning — semantics identical to the aai pipeline transport.
  endpointSettleMs?: number | undefined;
  completeSettleMs?: number | undefined;
  minBargeInWords?: number | undefined;
  interruptionMinDurationMs?: number | undefined;
  holdPhrase?: string | undefined;
  errorPhrase?: string | undefined;
  falseInterruptionTimeoutMs?: number | undefined;
  silenceTimeoutMs?: number | undefined;
  silencePrompt?: string | undefined;
  logger?: Logger | undefined;
}

/** Everything one connection needs, resolved once per channel. */
interface ResolvedVoiceConfig {
  opts: VoiceChannelOptions;
  stt: ResolvedOpener<SttOpener>;
  tts: ResolvedOpener<TtsOpener>;
  env: Record<string, string>;
  log: Logger;
  name: string;
  sttSampleRate: number;
  ttsSampleRate: number;
}

function pickEnv(vars: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of vars) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** One voice session: eve turn runner → pipeline transport → session core. */
function createVoiceSession(
  sid: string,
  client: Parameters<typeof createSessionCore>[0]["client"],
  routeArgs: VoiceRouteArgsLike,
  cfg: ResolvedVoiceConfig,
): SessionCore {
  // The transport's callbacks route into the core, which is created after
  // the transport — late-bind exactly like the aai runtime does.
  let core: SessionCore | undefined;
  const bindCore = (): SessionCore => {
    if (!core) throw new Error("voice session core not initialized");
    return core;
  };

  const callbacks: TransportCallbacks = {
    onReplyStarted: (replyId) => bindCore().onReplyStarted(replyId),
    onReplyDone: () => bindCore().onReplyDone(),
    onCancelled: () => bindCore().onCancelled(),
    onAudioChunk: (bytes) => bindCore().onAudioChunk(bytes),
    onAudioDone: () => bindCore().onAudioDone(),
    onUserTranscript: (text) => bindCore().onUserTranscript(text),
    onUserTranscriptPartial: (text) => bindCore().onUserTranscriptPartial(text),
    onAgentTranscript: (text, interrupted) => bindCore().onAgentTranscript(text, interrupted),
    // Observability only — the eve agent executes its own tools.
    onToolCall: (toolCallId, toolName, args) =>
      client.event({ type: "tool_call", toolCallId, toolName, args }),
    onToolCallDone: (toolCallId, result) =>
      client.event({ type: "tool_call_done", toolCallId, result }),
    onError: (code, message, errOpts) => bindCore().onError(code, message, errOpts),
    onSpeechStarted: () => bindCore().onSpeechStarted(),
    onSpeechStopped: () => bindCore().onSpeechStopped(),
  };

  const { opts } = cfg;
  const transport = createPipelineTransport({
    sid,
    stt: cfg.stt.opener,
    // The reply source is the eve agent, not a local LLM loop.
    llm: null,
    turnRunner: createEveTurnRunner({
      agent: routeAgentHandle(routeArgs),
      continuationToken: `voice:${sid}`,
    }),
    tts: cfg.tts.opener,
    callbacks,
    // The system prompt lives eve-side (instructions.md); the transport
    // never sees it and the turn runner ignores the field.
    sessionConfig: { systemPrompt: "", ...(opts.greeting ? { greeting: opts.greeting } : {}) },
    providerKeys: {
      stt: resolveApiKey(cfg.stt.envVar, cfg.env),
      tts: resolveApiKey(cfg.tts.envVar, cfg.env),
    },
    sttSampleRate: cfg.sttSampleRate,
    ttsSampleRate: cfg.ttsSampleRate,
    sttPrompt: opts.sttPrompt,
    endpointSettleMs: opts.endpointSettleMs,
    completeSettleMs: opts.completeSettleMs,
    minBargeInWords: opts.minBargeInWords,
    interruptionMinDurationMs: opts.interruptionMinDurationMs,
    holdPhrase: opts.holdPhrase,
    errorPhrase: opts.errorPhrase,
    falseInterruptionTimeoutMs: opts.falseInterruptionTimeoutMs,
    silenceTimeoutMs: opts.silenceTimeoutMs,
    silencePrompt: opts.silencePrompt,
    logger: cfg.log,
  });

  const agentConfig: AgentConfig = {
    name: cfg.name,
    systemPrompt: "",
    greeting: opts.greeting ?? "",
    mode: "pipeline",
  };

  core = createSessionCore({
    id: sid,
    agent: cfg.name,
    client,
    agentConfig,
    executeTool: async () => {
      throw new Error("voice channel tools execute inside the eve agent");
    },
    transport,
    logger: cfg.log,
  });
  return core;
}

/** Per-connection WebSocket hooks bridging the peer to a voice session. */
function voiceHooks(routeArgs: VoiceRouteArgsLike, cfg: ResolvedVoiceConfig): WebSocketRouteHooks {
  const sessions = new Map<string, SessionCore>();
  let bridge: PeerSocketBridge | null = null;
  return {
    open(peer: WebSocketPeer) {
      bridge = bridgePeerSocket(peer);
      wireSessionSocket(bridge.socket, {
        sessions,
        createSession: (sessionId, client) => createVoiceSession(sessionId, client, routeArgs, cfg),
        readyConfig: {
          audioFormat: "pcm16",
          sampleRate: cfg.sttSampleRate,
          ttsSampleRate: cfg.ttsSampleRate,
        },
        logger: cfg.log,
      });
      bridge.dispatchOpen();
    },
    message(_peer: WebSocketPeer, message: WebSocketMessage) {
      const raw = message.rawData;
      bridge?.dispatchMessage(typeof raw === "string" ? raw : message.uint8Array());
    },
    close(_peer: WebSocketPeer, details: { code?: number; reason?: string }) {
      bridge?.dispatchClose(details);
    },
    error(_peer: WebSocketPeer, error: Error) {
      bridge?.dispatchError(error.message);
    },
  };
}

/**
 * Create the eve voice channel. Export the result from
 * `agent/channels/voice.ts` in an eve app:
 *
 * ```ts
 * import { voiceChannel } from "@alexkroman1/aai-eve";
 * import { assemblyAI } from "@alexkroman1/aai/stt";
 * import { cartesia } from "@alexkroman1/aai/tts";
 *
 * export default voiceChannel({
 *   stt: assemblyAI({ model: "u3pro-rt" }),
 *   tts: cartesia({ voice: "..." }),
 *   greeting: "Hey! What can I do for you?",
 * });
 * ```
 */
export function voiceChannel(opts: VoiceChannelOptions): Channel {
  const stt = resolveStt(opts.stt);
  const tts = resolveTts(opts.tts);
  const cfg: ResolvedVoiceConfig = {
    opts,
    stt,
    tts,
    env: opts.env ?? pickEnv([stt.envVar, tts.envVar]),
    log: opts.logger ?? consoleLogger,
    name: opts.name ?? "Voice Agent",
    sttSampleRate: opts.sttSampleRate ?? DEFAULT_STT_SAMPLE_RATE,
    ttsSampleRate: opts.ttsSampleRate ?? DEFAULT_TTS_SAMPLE_RATE,
  };
  return defineChannel({
    routes: [
      WS(opts.path ?? "/websocket", (_req, args) =>
        voiceHooks(args as unknown as VoiceRouteArgsLike, cfg),
      ),
    ],
  });
}
