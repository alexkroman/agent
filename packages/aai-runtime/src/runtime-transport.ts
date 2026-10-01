// Copyright 2025 the AAI authors. MIT license.
/**
 * Transport selection and construction for the agent runtime.
 *
 * {@link createTransportFactory} closes over the runtime's resolved state
 * (providers, tool schemas, config) and returns the per-session
 * `buildTransport` used by `createRuntime` — picking pipeline, OpenAI
 * Realtime, or AssemblyAI S2S based on the agent's declaration.
 */

import { ASSEMBLYAI_S2S_KIND, OPENAI_S2S_KIND } from "@alexkroman1/aai/host-internal";
import { DEFAULT_TOOL_CHOICE } from "@alexkroman1/aai/internal";
import type { AgentConfig, ToolSchema } from "@alexkroman1/aai/manifest";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import type { OpenAIS2sOptions } from "@alexkroman1/aai/s2s";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { LanguageModel } from "ai";
import { type ProviderFailover, withOpenerFailoverListener } from "./providers/_failover.ts";
import { withFailoverListener } from "./providers/_fallback-llm.ts";
import type { SttOpener, TtsOpener } from "./providers/openers.ts";
import {
  descriptorKind,
  isS2sKind,
  type ResolvedOpener,
  resolveApiKey,
  resolveS2sEnvVar,
} from "./providers/resolve.ts";
import type { Logger, S2sConfig } from "./runtime-config.ts";
import type { HostRuntimeOptions, RuntimeOptions } from "./runtime-types.ts";
import type { ExecuteTool } from "./tool-executor.ts";
import { reportSessionCapabilities } from "./transports/capabilities.ts";
import { createOpenaiRealtimeTransport } from "./transports/openai-realtime-transport.ts";
import type { DialogTurnSource } from "./transports/pipeline-dialog-knobs.ts";
import type { TurnGuardrails } from "./transports/pipeline-guardrails.ts";
import type { PersonaTurnSource } from "./transports/pipeline-persona-knobs.ts";
import { createPipelineTransport } from "./transports/pipeline-transport.ts";
import { createS2sTransport } from "./transports/s2s-transport.ts";
import type { SystemPromptOption, Transport, TransportCallbacks } from "./transports/types.ts";
import { resolveSystemPrompt } from "./transports/types.ts";
import type { UsageMeter } from "./usage-meter.ts";

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

/**
 * A session's greeting, composed ONCE in `runtime.ts` from the three things that
 * decide it — the resume skip, `sessionContext`'s answer and the agent's own
 * line — so no builder below re-derives any of them.
 *
 * Both members are THUNKS, resolved when the greeting fires: the transport is
 * built before `sessionContext` answers (`runtime-session-memory.ts`) and before
 * the resume lookups run (`session-resume-found.ts`). An empty or absent result
 * means "do not greet".
 *
 * Two members rather than one because the resume skip is scoped to a
 * connection's OPENING line, and two readers want the line without it: the
 * pipeline's `reset()` starts a new conversation and must greet (see
 * `transports/CLAUDE.md`), and AssemblyAI S2S has never honoured a resume skip —
 * a known gap, kept as it was rather than changed here.
 *
 * @internal
 */
export type SessionGreeting = {
  /** The line to open THIS connection with: `""` when a resume skip applies, else {@link SessionGreeting.line}. */
  opening: () => string | undefined;
  /**
   * The session's line regardless of any resume: `sessionContext`'s answer when
   * it gave one (`""` is an answer — "no greeting this session"), else the
   * agent's.
   */
  line: () => string | undefined;
};

/** Per-session identifiers and client sink a transport is built for. */
export type TransportSessionOpts = {
  id: string;
  agent: string;
  client: ClientSink;
  /**
   * True when this connection presented an existing session id (`?sessionId=`),
   * so the session continues rather than begins.
   *
   * A different question from the resume skip folded into
   * {@link SessionGreeting.opening}, which is about what the CALLER has already
   * heard: this decides whether the server reads its own event stream back to
   * restore the conversation. Defaults to false, so a direct
   * `runtime.createSession()` caller gets a fresh session.
   */
  resumed?: boolean;
  /** This session's greeting — see {@link SessionGreeting}. */
  greeting: SessionGreeting;
};

/**
 * What `runtime.ts`'s `createSession` is called with: the transport's options
 * before the greeting is composed, plus the socket's resume CLAIM, which is
 * folded into {@link SessionGreeting.opening} and reaches no builder on its own.
 */
export type SessionBuildOpts = Omit<TransportSessionOpts, "greeting"> & {
  skipGreeting?: boolean;
};

/** Arguments to one `buildTransport` call (one per session). */
export type BuildTransportArgs = {
  sessionOpts: TransportSessionOpts;
  /**
   * The session's system prompt — a string, or the runtime's per-turn resolver.
   * See {@link SystemPromptOption}; `runtime.ts` passes the thunk.
   *
   * **Only two of the three branches below can honour a thunk**, and the
   * asymmetry is a property of the SERVICES rather than of this file. The
   * pipeline assembles a `streamText` request per turn and OpenAI Realtime can
   * be sent a fresh `session.update`; AssemblyAI S2S runs the tool loop
   * service-side, so the host is never on the path between two turns and has no
   * moment to resolve at. `buildAssemblyS2sTransport` therefore resolves ONCE,
   * at construction, which is exactly what shipped before this seam existed.
   */
  systemPrompt: SystemPromptOption;
  callbacks: TransportCallbacks;
  /**
   * The per-state voice knobs of this session's declared dialogs, or absent when
   * no declared state carries one — see `runtime-dialog-knobs.ts`.
   *
   * **Only the pipeline branch takes it**, and the asymmetry is the same one the
   * prompt thunk has for the same reason: two of the three knobs are `streamText`
   * request settings, and the two S2S services assemble their own requests
   * service-side. A dialog's `bargeIn` is likewise a decision the host makes only
   * in pipeline mode — both S2S services own turn-taking. `reportDialogKnobs`
   * warns for a knob nothing applies; it does not know the transport, so an
   * agent that declares one and runs on S2S is warned at session start from the
   * transport's `capabilities` instead (`transports/capabilities.ts`).
   */
  dialogTurn?: DialogTurnSource | undefined;
  /**
   * What this session's ACTIVE PERSONA asks of each step, or absent when the
   * agent declares no roster or one whose personas declare no model knob — see
   * `runtime-personas.ts`.
   *
   * **Only the pipeline branch takes it**, for the reason `dialogTurn` has: a
   * persona's `toolChoice`/`temperature` are `streamText` request settings, and
   * the two S2S services assemble their own requests. The persona's PROMPT
   * section and the execution gate on its tools hold on every transport
   * regardless; what an S2S session loses is the two knobs, warned about below.
   */
  personaTurn?: PersonaTurnSource | undefined;
  /**
   * This session's guardrails, already bound to their context.
   *
   * **Only the pipeline branch takes it**, and here the asymmetry is not a
   * limitation to work around later: `assertGuardrailScope` refuses the fields
   * outright for an s2s agent, because the provider synthesizes the audio and
   * the caller has heard the sentence by the time this process sees the text.
   * A guardrail forwarded to an S2S transport could only report.
   */
  guardrails?: TurnGuardrails | undefined;
  /**
   * This session's token meter — same rule as `guardrails`, same reason:
   * `assertSamplingScope` refuses `usageLimits` in s2s mode because the host
   * sees no token counts there, so a meter forwarded to an S2S transport would
   * report zeroes and a budget over it would never trip.
   */
  usage?: UsageMeter | undefined;
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
  s2sConfig: S2sConfig;
  /**
   * Resolves non-null exactly when the session mode is pipeline.
   *
   * A thunk because a `page: "static"` agent must not resolve providers it
   * will never dial (see `createRuntime`) — and a session that somehow starts
   * on one still gets the real credential error rather than this file's
   * "no transport for session".
   */
  pipelineProviders: () => ResolvedPipelineProviders | null;
  createWebSocket: HostRuntimeOptions["createWebSocket"];
  createOpenaiRealtimeWebSocket: HostRuntimeOptions["createOpenaiRealtimeWebSocket"];
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
    // A `fallback([...])` stage reports each switch into THIS session; every
    // other provider is passed through by identity (`_failover.ts`).
    const onFailover = (failover: ProviderFailover): void =>
      callbacks.report({ type: "provider.failed-over", ...failover });
    return createPipelineTransport({
      sid: sessionOpts.id,
      stt: withOpenerFailoverListener(providers.stt.opener, onFailover),
      llm: withFailoverListener(providers.llm, onFailover),
      tts: withOpenerFailoverListener(providers.tts.opener, onFailover),
      callbacks,
      // The LINE, not the opening: `reset()` re-greets through `greeting`, and the
      // resume skip must not reach it. The opening line is `skipGreeting`'s
      // only question — empty (a skip, or no greeting at all) keeps the start
      // silent, which is what either input meant on its own.
      sessionConfig: { systemPrompt, greeting: sessionOpts.greeting.line },
      skipGreeting: () => !sessionOpts.greeting.opening(),
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
      resetToolChoice: agentConfig.resetToolChoice,
      temperature: agentConfig.temperature,
      maxOutputTokens: agentConfig.maxOutputTokens,
      maxRetries: agentConfig.maxRetries,
      ...omitUndefined({ guardrails: args.guardrails, usage: args.usage }),
      ...omitUndefined({ sttPrompt: agentConfig.sttPrompt }),
      silenceTimeoutMs: agentConfig.silenceTimeoutMs,
      silencePrompt: agentConfig.silencePrompt,
      userTurnLimit: agentConfig.userTurnLimit,
      turnDetection: agentConfig.turnDetection,
      minBargeInWords: agentConfig.minBargeInWords,
      interruptionMinDurationMs: agentConfig.interruptionMinDurationMs,
      // Not an agent field: the pair the STT stage resolved, so a rule's
      // window is clamped against the ceiling the socket really dialled.
      startSpeakingFloorMs: agentConfig.startSpeakingFloorMs,
      interruptionBackoffMs: agentConfig.interruptionBackoffMs,
      deadAirCoverMs: agentConfig.deadAirCoverMs,
      // errorPhrase used to be missing here, so an agent that set it (including
      // to "" to disable) silently got the default instead.
      errorPhrase: agentConfig.errorPhrase,
      startFailurePhrase: agentConfig.startFailurePhrase,
      resumeFalseInterruption: agentConfig.resumeFalseInterruption,
      preemptiveGeneration: agentConfig.preemptiveGeneration,
      ...omitUndefined({ dialogTurn: args.dialogTurn, personaTurn: args.personaTurn }),
      logger,
    });
  }

  /**
   * Session start: say, once per runtime, what this transport cannot do of
   * what the session declared — `reportSessionCapabilities` reads the
   * descriptor, so the warnings and their wording live with the capability
   * table, not in a branch per transport. A warning rather than a refusal for
   * the two knob rows: a dialog's states and a persona's prompt and gate still
   * hold, so nothing is unsafe, and the alternative is throwing on a caller
   * already on the line.
   */
  const reported = new Set<string>();
  const declaresOnError = Object.values(agent.tools ?? {}).some((t) => t.onError !== undefined);
  function reportCapabilities(
    transport: Transport,
    name: string,
    args: BuildTransportArgs,
  ): Transport {
    reportSessionCapabilities(
      transport.capabilities,
      name,
      {
        dialogKnobs: args.dialogTurn !== undefined,
        personaKnobs: args.personaTurn !== undefined,
        fatalTool: declaresOnError,
      },
      logger,
      reported,
    );
    return transport;
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
      // Read once, when the socket opens: the connection's opening line, with the
      // resume skip already folded in.
      sessionConfig: { systemPrompt, greeting: sessionOpts.greeting.opening },
      toolSchemas,
      toolChoice: agentConfig.toolChoice ?? DEFAULT_TOOL_CHOICE,
      callbacks,
      sid: sessionOpts.id,
      inputSampleRate: s2sConfig.inputSampleRate,
      outputSampleRate: s2sConfig.outputSampleRate,
      ...omitUndefined({ createWebSocket: createOpenaiRealtimeWebSocket }),
      logger,
    });
  }

  function buildAssemblyS2sTransport(args: BuildTransportArgs): Transport {
    const { sessionOpts, systemPrompt, callbacks } = args;
    // THE resolution point for this transport, and the only one it gets.
    // `S2sSessionConfig.systemPrompt` is the SDK's own wire type and takes a
    // string, which is honest here: the service holds the conversation and
    // dispatches replies from the config it was handed, so there is no
    // per-turn callback into this process to re-resolve from. A `dialog()`
    // phase therefore reaches an S2S agent through tool results alone —
    // the limitation this seam removes for the other two transports, stated
    // where a reader wiring a third one will hit it.
    const prompt = resolveSystemPrompt(systemPrompt);
    // The LINE: this transport has never honoured a resume skip (see
    // `SessionGreeting`), and folding one in here would change what a resumed
    // S2S session says.
    const greeting = sessionOpts.greeting.line;
    return createS2sTransport({
      apiKey: s2sApiKey(),
      s2sConfig,
      // A THUNK, built when `start()` sends it, only so the greeting is the one
      // `sessionContext` answered. The prompt is still resolved here, once.
      sessionConfig: () => ({
        systemPrompt: prompt,
        tools: toolSchemas,
        ...omitUndefined({ greeting: greeting() }),
        // Forwarded on its own presence, like the pipeline branch above. Omitting
        // it here is what made `sttPrompt` a silent no-op for every S2S agent.
        ...omitUndefined({ sttPrompt: agentConfig.sttPrompt }),
        // Read from the stored descriptor rather than from `agentConfig`: these
        // are vendor options, so they ride on `s2s.options` and never become
        // top-level config fields. Same dropped-field class as `sttPrompt` —
        // the descriptor took no options at all until these were added.
        ...readAssemblyS2sOptions(agentConfig.s2s?.options),
      }),
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
      return reportCapabilities(buildPipelineTransport(args, resolved), "pipeline", args);
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
          return reportCapabilities(buildOpenaiRealtimeTransport(args), "OpenAI Realtime", args);
        case ASSEMBLYAI_S2S_KIND:
          return reportCapabilities(buildAssemblyS2sTransport(args), "AssemblyAI S2S", args);
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
