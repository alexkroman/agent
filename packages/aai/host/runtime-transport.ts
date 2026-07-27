// Copyright 2025 the AAI authors. MIT license.
/**
 * Transport selection and construction for the agent runtime.
 *
 * {@link createTransportFactory} closes over the runtime's resolved state
 * (providers, tool schemas, config) and returns the per-session
 * `buildTransport` used by `createRuntime` — picking pipeline, OpenAI
 * Realtime, or AssemblyAI S2S based on the agent's declaration.
 */

import type { LanguageModel } from "ai";
import type { AgentConfig, ToolSchema } from "../sdk/_internal-types.ts";
import type { ClientSink } from "../sdk/protocol.ts";
import { OPENAI_API_KEY_ENV } from "../sdk/providers/llm/openai.ts";
import {
  OPENAI_REALTIME_KIND,
  type OpenaiRealtimeOptions,
} from "../sdk/providers/s2s/openai-realtime.ts";
import { ASSEMBLYAI_API_KEY_ENV } from "../sdk/providers/stt/assemblyai.ts";
import type { SttOpener, TtsOpener } from "../sdk/providers.ts";
import { descriptorKind, type ResolvedOpener, resolveApiKey } from "./providers/resolve.ts";
import type { Logger, S2SConfig } from "./runtime-config.ts";
import type { RuntimeOptions } from "./runtime-types.ts";
import type { ExecuteTool } from "./tool-executor.ts";
import { createOpenaiRealtimeTransport } from "./transports/openai-realtime-transport.ts";
import { createPipelineTransport } from "./transports/pipeline-transport.ts";
import { createS2sTransport } from "./transports/s2s-transport.ts";
import type { Transport, TransportCallbacks } from "./transports/types.ts";

/** Per-session identifiers and client sink a transport is built for. */
export type TransportSessionOpts = {
  id: string;
  agent: string;
  client: ClientSink;
  skipGreeting?: boolean;
};

/** Arguments to one `buildTransport` call (one per session). */
export type BuildTransportArgs = {
  sessionOpts: TransportSessionOpts;
  systemPrompt: string;
  callbacks: TransportCallbacks;
};

/**
 * The three pipeline provider instances, resolved once per runtime. STT and TTS
 * carry the env var their credential lives in, so the transport builder reads
 * keys from here instead of being handed the raw descriptors a second time.
 */
export type ResolvedPipelineProviders = {
  stt: ResolvedOpener<SttOpener>;
  llm: LanguageModel;
  tts: ResolvedOpener<TtsOpener>;
};

/** Runtime-scoped state the transport builders close over. */
export interface TransportFactoryDeps {
  agent: RuntimeOptions["agent"];
  agentConfig: AgentConfig;
  toolSchemas: ToolSchema[];
  executeTool: ExecuteTool;
  env: Record<string, string>;
  s2sConfig: S2SConfig;
  /** Non-null exactly when the session mode is pipeline. */
  pipelineProviders: ResolvedPipelineProviders | null;
  createWebSocket: RuntimeOptions["createWebSocket"];
  createOpenaiRealtimeWebSocket: RuntimeOptions["createOpenaiRealtimeWebSocket"];
  logger: Logger;
}

/**
 * Build the per-session transport constructor. Transport choice:
 * pipeline when pipeline providers resolved, otherwise the `s2s` field's
 * provider kind (OpenAI Realtime), otherwise AssemblyAI S2S (default).
 */
export function createTransportFactory(
  deps: TransportFactoryDeps,
): (args: BuildTransportArgs) => Transport {
  const {
    agent,
    agentConfig,
    toolSchemas,
    executeTool,
    env,
    s2sConfig,
    pipelineProviders,
    createWebSocket,
    createOpenaiRealtimeWebSocket,
    logger,
  } = deps;

  function buildPipelineTransport(
    args: BuildTransportArgs,
    providers: ResolvedPipelineProviders,
  ): Transport {
    const { sessionOpts, systemPrompt, callbacks } = args;
    return createPipelineTransport({
      sid: sessionOpts.id,
      stt: providers.stt.opener,
      llm: providers.llm,
      tts: providers.tts.opener,
      callbacks,
      sessionConfig: {
        systemPrompt,
        greeting: agentConfig.greeting,
      },
      toolSchemas,
      executeTool,
      providerKeys: {
        stt: resolveApiKey(providers.stt.envVar, env),
        tts: resolveApiKey(providers.tts.envVar, env),
      },
      sttSampleRate: s2sConfig.inputSampleRate,
      ttsSampleRate: s2sConfig.outputSampleRate,
      maxSteps: agentConfig.maxSteps,
      toolChoice: agentConfig.toolChoice,
      ...(agentConfig.sttPrompt !== undefined ? { sttPrompt: agentConfig.sttPrompt } : {}),
      silenceTimeoutMs: agentConfig.silenceTimeoutMs,
      silencePrompt: agentConfig.silencePrompt,
      minBargeInWords: agentConfig.minBargeInWords,
      interruptionMinDurationMs: agentConfig.interruptionMinDurationMs,
      endpointSettleMs: agentConfig.endpointSettleMs,
      completeSettleMs: agentConfig.completeSettleMs,
      holdPhrase: agentConfig.holdPhrase,
      falseInterruptionTimeoutMs: agentConfig.falseInterruptionTimeoutMs,
      skipGreeting: sessionOpts.skipGreeting ?? false,
      logger,
    });
  }

  function buildOpenaiRealtimeTransport(args: BuildTransportArgs): Transport {
    const { sessionOpts, systemPrompt, callbacks } = args;
    return createOpenaiRealtimeTransport({
      apiKey: resolveApiKey(OPENAI_API_KEY_ENV, env),
      options: (agent.s2s?.options ?? {}) as OpenaiRealtimeOptions,
      sessionConfig: {
        systemPrompt,
        ...(agentConfig.greeting !== undefined ? { greeting: agentConfig.greeting } : {}),
      },
      toolSchemas,
      toolChoice: agentConfig.toolChoice ?? "auto",
      callbacks,
      sid: sessionOpts.id,
      inputSampleRate: s2sConfig.inputSampleRate,
      outputSampleRate: s2sConfig.outputSampleRate,
      skipGreeting: sessionOpts.skipGreeting ?? false,
      ...(createOpenaiRealtimeWebSocket ? { createWebSocket: createOpenaiRealtimeWebSocket } : {}),
      logger,
    });
  }

  function buildAssemblyS2sTransport(args: BuildTransportArgs): Transport {
    const { sessionOpts, systemPrompt, callbacks } = args;
    return createS2sTransport({
      apiKey: env[ASSEMBLYAI_API_KEY_ENV] ?? "",
      s2sConfig,
      sessionConfig: {
        systemPrompt,
        tools: toolSchemas,
        ...(agentConfig.greeting !== undefined ? { greeting: agentConfig.greeting } : {}),
      },
      callbacks,
      sid: sessionOpts.id,
      agent: sessionOpts.agent,
      ...(createWebSocket ? { createWebSocket } : {}),
      logger,
    });
  }

  return function buildTransport(args: BuildTransportArgs): Transport {
    if (pipelineProviders) {
      return buildPipelineTransport(args, pipelineProviders);
    }
    if (agent.s2s !== undefined) {
      const kind = descriptorKind(agent.s2s);
      if (kind === OPENAI_REALTIME_KIND) {
        return buildOpenaiRealtimeTransport(args);
      }
      throw new Error(`Unknown s2s provider kind: ${kind ?? "<missing>"}`);
    }
    return buildAssemblyS2sTransport(args);
  };
}
