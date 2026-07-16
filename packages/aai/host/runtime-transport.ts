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
import type { SttOpener, SttProvider, TtsOpener, TtsProvider } from "../sdk/providers.ts";
import {
  descriptorKind,
  resolveApiKey,
  resolveSttApiKey,
  resolveTtsApiKey,
} from "./providers/resolve.ts";
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

/** The three pipeline provider instances, resolved once per runtime. */
export type ResolvedPipelineProviders = {
  stt: SttOpener;
  llm: LanguageModel;
  tts: TtsOpener;
};

/** Runtime-scoped state the transport builders close over. */
export interface TransportFactoryDeps {
  agent: RuntimeOptions["agent"];
  agentConfig: AgentConfig;
  toolSchemas: ToolSchema[];
  executeTool: ExecuteTool;
  env: Record<string, string>;
  s2sConfig: S2SConfig;
  /** Raw (unresolved) providers — API keys resolve per descriptor. */
  effectiveProviders: {
    stt: SttProvider | SttOpener | undefined;
    tts: TtsProvider | TtsOpener | undefined;
  };
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
    effectiveProviders,
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
      stt: providers.stt,
      llm: providers.llm,
      tts: providers.tts,
      callbacks,
      sessionConfig: {
        systemPrompt,
        greeting: agentConfig.greeting,
      },
      toolSchemas,
      executeTool,
      providerKeys: {
        stt: resolveSttApiKey(effectiveProviders.stt, env),
        tts: resolveTtsApiKey(effectiveProviders.tts, env),
      },
      sttSampleRate: s2sConfig.inputSampleRate,
      ttsSampleRate: s2sConfig.outputSampleRate,
      maxSteps: agentConfig.maxSteps,
      toolChoice: agentConfig.toolChoice,
      ...(agentConfig.sttPrompt !== undefined ? { sttPrompt: agentConfig.sttPrompt } : {}),
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
