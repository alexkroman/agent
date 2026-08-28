// Copyright 2025 the AAI authors. MIT license.
/**
 * Transport selection and construction for the agent runtime.
 *
 * {@link createTransportFactory} closes over the runtime's resolved state
 * (providers, tool schemas, config) and returns the per-session
 * `buildTransport` used by `createRuntime` — picking pipeline, OpenAI
 * Realtime, or AssemblyAI S2S based on the agent's declaration.
 */

import type { SttOpener, TtsOpener } from "@alexkroman1/aai/host-internal";
import { ASSEMBLYAI_S2S_KIND, OPENAI_S2S_KIND } from "@alexkroman1/aai/host-internal";
import { DEFAULT_TOOL_CHOICE } from "@alexkroman1/aai/internal";
import type { AgentConfig, ToolSchema } from "@alexkroman1/aai/manifest";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import type { OpenAIS2sOptions } from "@alexkroman1/aai/s2s";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { LanguageModel } from "ai";
import {
  descriptorKind,
  isS2sKind,
  type ResolvedOpener,
  resolveApiKey,
  resolveS2sEnvVar,
} from "./providers/resolve.ts";
import type { Logger, S2SConfig } from "./runtime-config.ts";
import type { RuntimeOptions } from "./runtime-types.ts";
import type { ExecuteTool } from "./tool-executor.ts";
import { createOpenaiRealtimeTransport } from "./transports/openai-realtime-transport.ts";
import { createPipelineTransport } from "./transports/pipeline-transport.ts";
import { createS2sTransport } from "./transports/s2s-transport.ts";
import type { SkipGreeting, Transport, TransportCallbacks } from "./transports/types.ts";

/**
 * Read the author-set `assemblyAIS2s({ voice, languages, keyterms })` options
 * off the stored descriptor.
 *
 * Narrowed field by field rather than asserted: `options` is
 * `Record<string, unknown>` at the descriptor boundary because a config that
 * crossed the wire was validated by `ProviderDescriptorSchema`, which does not
 * know any one vendor's option shape. A malformed value is DROPPED rather than
 * forwarded — an unset field means "service default" everywhere in this path,
 * which is the safe reading, whereas putting a non-string on the wire would be
 * a rejected `session.update` on a session that otherwise looks healthy.
 */
function readAssemblyS2sOptions(options: Record<string, unknown> | undefined): {
  voice?: string;
  languages?: readonly string[];
  keyterms?: readonly string[];
} {
  const isStringArray = (v: unknown): v is readonly string[] =>
    Array.isArray(v) && v.every((entry) => typeof entry === "string");
  const voice = options?.voice;
  const languages = options?.languages;
  const keyterms = options?.keyterms;
  return {
    ...(typeof voice === "string" ? { voice } : {}),
    ...(isStringArray(languages) ? { languages } : {}),
    ...(isStringArray(keyterms) ? { keyterms } : {}),
  };
}

/** Per-session identifiers and client sink a transport is built for. */
export type TransportSessionOpts = {
  id: string;
  agent: string;
  client: ClientSink;
  skipGreeting?: SkipGreeting;
  /**
   * True when this connection presented an existing session id (`?sessionId=`),
   * so the session continues rather than begins.
   *
   * A different question from `skipGreeting`, which is about what the CALLER has
   * already heard: this decides whether the server reads its own event stream
   * back to restore the conversation. Defaults to false, so a direct
   * `runtime.createSession()` caller gets a fresh session.
   */
  resumed?: boolean;
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
  /**
   * Resolves non-null exactly when the session mode is pipeline.
   *
   * A thunk because a `page: "static"` agent must not resolve providers it
   * will never dial (see `createRuntime`) — and a session that somehow starts
   * on one still gets the real credential error rather than this file's
   * "no transport for session".
   */
  pipelineProviders: () => ResolvedPipelineProviders | null;
  createWebSocket: RuntimeOptions["createWebSocket"];
  createOpenaiRealtimeWebSocket: RuntimeOptions["createOpenaiRealtimeWebSocket"];
  logger: Logger;
}

/**
 * Build the per-session transport constructor. Transport choice:
 * pipeline when pipeline providers resolved (the default — provider
 * resolution injects the AssemblyAI pipeline when nothing is declared),
 * otherwise the `s2s` field's provider kind (AssemblyAI S2S or OpenAI
 * Realtime).
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
      temperature: agentConfig.temperature,
      ...omitUndefined({ sttPrompt: agentConfig.sttPrompt }),
      silenceTimeoutMs: agentConfig.silenceTimeoutMs,
      silencePrompt: agentConfig.silencePrompt,
      minBargeInWords: agentConfig.minBargeInWords,
      interruptionMinDurationMs: agentConfig.interruptionMinDurationMs,
      deadAirCoverMs: agentConfig.deadAirCoverMs,
      // errorPhrase used to be missing here, so an agent that set it (including
      // to "" to disable) silently got the default instead.
      errorPhrase: agentConfig.errorPhrase,
      startFailurePhrase: agentConfig.startFailurePhrase,
      resumeFalseInterruption: agentConfig.resumeFalseInterruption,
      preemptiveGeneration: agentConfig.preemptiveGeneration,
      skipGreeting: sessionOpts.skipGreeting ?? false,
      logger,
    });
  }

  /**
   * The env var this agent's S2S credential lives in. Registry-derived (and
   * `apiKeyEnv`-overridable) rather than a literal per builder, so the key the
   * session reads is the same one `requiredProviderEnvVars` preflights — a
   * disagreement there passes deploy and then fails at first session.
   * Only called from the s2s branch of `buildTransport`, where `agent.s2s` is set.
   */
  function s2sApiKey(): string {
    return agent.s2s === undefined ? "" : resolveApiKey(resolveS2sEnvVar(agent.s2s), env);
  }

  function buildOpenaiRealtimeTransport(args: BuildTransportArgs): Transport {
    const { sessionOpts, systemPrompt, callbacks } = args;
    return createOpenaiRealtimeTransport({
      apiKey: s2sApiKey(),
      options: (agent.s2s?.options ?? {}) as OpenAIS2sOptions,
      sessionConfig: {
        systemPrompt,
        ...omitUndefined({ greeting: agentConfig.greeting }),
      },
      toolSchemas,
      toolChoice: agentConfig.toolChoice ?? DEFAULT_TOOL_CHOICE,
      callbacks,
      sid: sessionOpts.id,
      inputSampleRate: s2sConfig.inputSampleRate,
      outputSampleRate: s2sConfig.outputSampleRate,
      skipGreeting: sessionOpts.skipGreeting ?? false,
      ...omitUndefined({ createWebSocket: createOpenaiRealtimeWebSocket }),
      logger,
    });
  }

  function buildAssemblyS2sTransport(args: BuildTransportArgs): Transport {
    const { sessionOpts, systemPrompt, callbacks } = args;
    return createS2sTransport({
      apiKey: s2sApiKey(),
      s2sConfig,
      sessionConfig: {
        systemPrompt,
        tools: toolSchemas,
        ...omitUndefined({ greeting: agentConfig.greeting }),
        // Forwarded on its own presence, like the pipeline branch above. Omitting
        // it here is what made `sttPrompt` a silent no-op for every S2S agent.
        ...omitUndefined({ sttPrompt: agentConfig.sttPrompt }),
        // Read from the stored descriptor rather than from `agentConfig`: these
        // are vendor options, so they ride on `s2s.options` and never become
        // top-level config fields. Same dropped-field class as `sttPrompt` —
        // the descriptor took no options at all until these were added.
        ...readAssemblyS2sOptions(agentConfig.s2s?.options),
      },
      callbacks,
      sid: sessionOpts.id,
      agent: sessionOpts.agent,
      ...omitUndefined({ createWebSocket }),
      logger,
    });
  }

  return function buildTransport(args: BuildTransportArgs): Transport {
    const resolved = pipelineProviders();
    if (resolved) {
      return buildPipelineTransport(args, resolved);
    }
    if (agent.s2s !== undefined) {
      const kind = descriptorKind(agent.s2s);
      // Narrow through the registry first: that turns the switch below into
      // an exhaustiveness check over `S2sKind` (see its `default`), so a
      // vendor added to the registry is a compile error here until it has a
      // builder, rather than a runtime throw at a caller's first session.
      if (!isS2sKind(kind)) {
        throw new Error(`Unknown s2s provider kind: ${kind ?? "<missing>"}`);
      }
      switch (kind) {
        case OPENAI_S2S_KIND:
          return buildOpenaiRealtimeTransport(args);
        case ASSEMBLYAI_S2S_KIND:
          return buildAssemblyS2sTransport(args);
        default: {
          // `kind` is `never` here, which is the point: adding a member to
          // `S2sKind` (i.e. an entry to S2S_REGISTRY) fails to compile until
          // it has a builder above, instead of reaching this throw at a
          // caller's first session.
          const unhandled: never = kind;
          throw new Error(`Unhandled s2s provider kind: ${String(unhandled)}`);
        }
      }
    }
    // Unreachable on any current path: provider resolution injects the
    // pipeline when nothing is declared, so S2S only happens via an explicit
    // descriptor. Fail loudly rather than fall back (the pre-flip legacy
    // fallback that lived here is gone) — never let S2S be a fallback.
    throw new Error(
      "No transport for session: pipeline providers unresolved and no s2s descriptor set",
    );
  };
}

/**
 * Will this agent's sessions run on the AssemblyAI S2S transport?
 *
 * Lives here so it stays in step with `buildTransport`'s dispatch above. The
 * runtime asks before building its ready config, because that transport's
 * output rate is fixed by the service rather than negotiable — see
 * `pinAssemblyS2sRates`.
 *
 * @internal
 */
export function usesAssemblyS2s(agent: RuntimeOptions["agent"]): boolean {
  return agent.s2s !== undefined && descriptorKind(agent.s2s) === ASSEMBLYAI_S2S_KIND;
}
