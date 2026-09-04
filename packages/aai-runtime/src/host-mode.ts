// Copyright 2026 the AAI authors. MIT license.
/**
 * Host mode — run a per-connection agent supplied by the client instead of the
 * deployed agent.
 *
 * A host-mode WebSocket connection begins with a single `config` frame that
 * carries a {@link HostConfig} block (`systemPrompt`, optional `greeting`, and
 * relayed `tools`). Because the deployed-agent flow builds the session's
 * transport synchronously on socket-open (before any client message can
 * arrive), host mode DEFERS
 * `runtime.startSession` until that first frame lands: {@link startHostSession}
 * holds the raw socket, waits for the handshake, then builds a fresh, single-use
 * {@link Runtime} whose tools are executed by a {@link createRelayExecuteTool}
 * relay. The relay emits `tool_call` frames to the client and resolves each call
 * when the matching inbound `tool_result` arrives.
 */

import type { AgentDef } from "@alexkroman1/aai";
import {
  ASSEMBLYAI_S2S_SAMPLE_RATE,
  DEFAULT_HOST_HANDSHAKE_TIMEOUT_MS,
  WS_OPEN,
} from "@alexkroman1/aai/host-internal";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { HostConfig, SessionEventBody } from "@alexkroman1/aai/protocol";
import { HostConfigMessageSchema } from "@alexkroman1/aai/protocol";
import { errorMessage, omitUndefined, safeJsonParse } from "@alexkroman1/aai/utils";
import { UNPACED_AUDIO_LEAD_MS } from "./audio-pacer.ts";
import { createRelayExecuteTool } from "./host-relay.ts";
import { ALL_PROVIDER_ENV_VARS } from "./providers/resolve.ts";
import { createRuntime, type RuntimeOptions, type SessionStartOptions } from "./runtime.ts";
import type { Logger, S2sConfig } from "./runtime-config.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime-config.ts";
import { usesAssemblyS2s } from "./runtime-transport.ts";
import { stampSessionEvent } from "./session-event-stream.ts";
import { type SessionWebSocket, safeSend } from "./ws-handler.ts";

/**
 * Default `maxSteps` for a host agent. Host tasks (e.g. tau2 simulations) may
 * chain several tool calls per turn, so this is more generous than a typical
 * conversational agent.
 *
 * Exported so `host-mode.test.ts` can import it rather than hand-mirroring the
 * literal: a copied constant is the pattern the package guide records failing
 * twice with the voices list. Not re-exported from `runtime-barrel.ts`, so this
 * widens no published surface.
 */
export const DEFAULT_HOST_MAX_STEPS = 30;

/**
 * Translate `HostConfig.audioLeadMs` into the session-start override.
 *
 * Absent means "leave the pacer's own default alone", so the field is OMITTED
 * rather than set to a number here — passing one would fork the default.
 */
function hostAudioLead(declared: number | null | undefined): { audioLeadMs?: number } {
  if (declared === null) return { audioLeadMs: UNPACED_AUDIO_LEAD_MS };
  if (declared === undefined) return {};
  return { audioLeadMs: declared };
}

/**
 * Whether host mode is permitted for this environment.
 *
 * Opt-in: host mode is enabled only by an explicit `AAI_ALLOW_HOST` of
 * `1`/`true`/`yes`/`on` (case-insensitive). Anything else — including the
 * variable being unset — disables it.
 *
 * This used to default to enabled, which was fail-open for a feature that
 * lets an unauthenticated client replace the agent definition: a `?host=1`
 * connection supplies its own `systemPrompt`, `greeting`, and relayed tool
 * schemas, and the resulting session runs on the operator's provider
 * credentials. Since the self-hosted server has no request authentication of
 * its own, anyone who could reach the port could drive an arbitrary agent on
 * the operator's keys. Harnesses that need host mode (e.g. an external
 * evaluation harness) now set the variable explicitly.
 *
 * @internal
 */
export function isHostAllowed(env: Record<string, string>): boolean {
  const normalized = env.AAI_ALLOW_HOST?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * The first credential name in `credentials` that is not a provider
 * credential, or `undefined` when every name is allowed.
 *
 * Bounded by {@link ALL_PROVIDER_ENV_VARS} — the same vocabulary that bounds
 * `withHostCredentialFallback`, and for the same reason: this record is merged
 * into the env of the per-connection runtime, which reads far more than
 * provider keys out of it. An unbounded merge would let a `?host=1` client set
 * `DATABASE_URL` and have the server open `ctx.db` against a Postgres it
 * controls, or set `AAI_ALLOW_HOST` and self-approve.
 *
 * Unknown names are REJECTED rather than dropped. Silently ignoring them turns
 * a typo (`ASSEMBLYAI_KEY`) into a confusing provider-resolution failure two
 * layers down, and turns a genuine attempt to smuggle `DATABASE_URL` into
 * something the operator never hears about.
 *
 * @internal
 */
export function unknownCredentialName(
  credentials: Record<string, string> | undefined,
): string | undefined {
  if (!credentials) return;
  return Object.keys(credentials).find((name) => !ALL_PROVIDER_ENV_VARS.includes(name));
}

/**
 * The env the per-connection runtime is built from: the server's own env with
 * the client's credentials layered on top.
 *
 * The client WINS on conflict. That is the point of the field — a host server
 * can hold no credentials at all and let each session run on the caller's key
 * — and it is not an escalation: substituting a key you own spends your quota,
 * not the operator's, and reveals nothing about what the operator had.
 *
 * Callers must screen with {@link unknownCredentialName} first.
 *
 * @internal
 */
export function withHostCredentials(
  env: Record<string, string>,
  credentials: Record<string, string> | undefined,
): Record<string, string> {
  return credentials ? { ...env, ...credentials } : env;
}

/**
 * Synthesize an {@link AgentDef} from a host block. Host tools are relayed to
 * the client rather than executed in-process, so the agent carries no real
 * `ToolDef`s — the tool schemas are supplied to the runtime separately via
 * {@link RuntimeOptions.toolSchemas}.
 *
 * When a `baseAgent` (the server's deployed agent) is provided, its provider
 * config (`stt`/`llm`/`tts` and other pipeline settings) is inherited so the
 * host session runs the SAME pipeline the operator configured — only the
 * system prompt, greeting, and tools are overridden by the injected host
 * block.
 *
 * Without a `baseAgent` no providers are set, and `createRuntime` then fills
 * all three from the default all-AssemblyAI pipeline — NOT, as this comment
 * claimed before the pipeline-by-default flip, the S2S path. S2S has needed an
 * explicit `s2s` descriptor since; there is no fallback to it left. So a host
 * server that wants the default pipeline needs no base agent at all, and
 * inventing a placeholder one to carry providers it does not have is wasted
 * ceremony.
 *
 * `maxSteps` follows the same inheritance rule as the provider triple and
 * `sttPrompt`: the operator's value stands, and {@link DEFAULT_HOST_MAX_STEPS}
 * is what an unconfigured host server gets. It used to be written
 * unconditionally on the line after the spread, so
 * `createHostServer({ defaults: { maxSteps } })` — a documented knob on a type
 * that explicitly admits the field — was accepted, type-checked, and silently
 * discarded, and every tenant ran 30 steps. The host block cannot set it (there
 * is no `maxSteps` in `HostConfigSchema`), so the base agent is the only voice.
 *
 * @internal
 */
export function buildHostAgent(host: HostConfig, baseAgent?: AgentDef): AgentDef {
  return {
    ...(baseAgent ?? {}),
    name: baseAgent?.name ?? "host",
    systemPrompt: host.systemPrompt,
    greeting: host.greeting ?? "",
    maxSteps: baseAgent?.maxSteps ?? DEFAULT_HOST_MAX_STEPS,
    // STT biasing follows the provider triple's inheritance rule: the client's
    // value wins when sent, the operator's configured prompt stands otherwise.
    ...omitUndefined({ sttPrompt: host.sttPrompt }),
    // Injected tools are relayed to the client, not executed in-process.
    tools: {},
  };
}

/**
 * Options for {@link startHostSession}.
 * @internal
 */
export type StartHostSessionOptions = {
  /**
   * The agent env, or a promise of it. Pass a pending fetch (e.g. a Vault
   * lookup) rather than awaiting it first: `ws` does not buffer messages for
   * late listeners, so awaiting before calling this function loses the
   * client's one-and-only handshake frame.
   */
  env: Record<string, string> | PromiseLike<Record<string, string>>;
  startOpts?: SessionStartOptions;
  logger?: Logger;
  /**
   * The server's deployed agent. Its `stt`/`llm`/`tts` provider config is
   * inherited by the host session so it runs the operator's configured
   * pipeline (rather than defaulting to S2S). Only prompt/greeting/tools are
   * overridden by the client's host block.
   */
  baseAgent?: AgentDef;
  /** Handshake grace period (default `DEFAULT_HOST_HANDSHAKE_TIMEOUT_MS`, 15 000 ms). */
  handshakeTimeoutMs?: number;
  /** Per-tool relay timeout (default `DEFAULT_RELAY_TOOL_TIMEOUT_MS`, 120 000 ms). */
  relayTimeoutMs?: number;
  /** Injectable runtime factory (test seam). Defaults to {@link createRuntime}. */
  createRuntime?: (opts: RuntimeOptions) => ReturnType<typeof createRuntime>;
  /**
   * Whether this connection may use host mode, overriding the `AAI_ALLOW_HOST`
   * env gate.
   *
   * The self-hosted dev server leaves this unset: it is single-user and
   * loopback-bound, so an operator env flag is the right control. The
   * multi-tenant platform passes `true` only after verifying the caller owns
   * the slug — there, an env flag would be all-or-nothing across tenants, and
   * host mode spends the *owner's* provider credentials.
   */
  allowHost?: boolean | undefined;
};

/**
 * Send one event straight down the socket, stamping its envelope here.
 *
 * The two callers are the frames host mode has NO SESSION EMITTER for, and they
 * are different kinds of exception:
 *
 * - A handshake rejection is sent before any session is built, so there is
 *   nothing to record it in. Correct as-is.
 * - A relayed `tool.called` is a KNOWN GAP: the relay executor is constructed as
 *   the runtime's `executeTool`, i.e. before `createSession` builds the emitter,
 *   so a host-mode relay session's tool calls do not reach its retained stream
 *   (and never reached the audio pacer either). Host mode is the eval-harness
 *   path; closing it means late-binding the emitter into the relay.
 */
function sendEvent(ws: SessionWebSocket, event: SessionEventBody, log: Logger): void {
  safeSend(ws, JSON.stringify(stampSessionEvent(event)), log);
}

function rejectHandshake(ws: SessionWebSocket, log: Logger, message: string): void {
  log.warn("host-mode handshake rejected", { message });
  sendEvent(ws, { type: "error.reported", code: "protocol", message, fatal: true }, log);
  // Give the frame a tick to flush before closing.
  setTimeout(() => {
    try {
      ws.close?.(1008);
    } catch {
      // ignore
    }
  }, 0);
}

/**
 * Refuse a handshake whose declared audio rates this transport cannot honour.
 *
 * The host-side counterpart of aai-ui's `assertGranted`: a client states the
 * rate it will use, and a mismatch is a LOUD failure rather than a silent
 * override. It has to be loud here because the AssemblyAI Voice Agent API
 * accepts 24 kHz alone and honours no declaration to the contrary — so audio at
 * any other rate is decoded at 24 kHz anyway, and the service then emits
 * NOTHING: no speech edge, no transcript, no error. Measured live, 16 kHz audio
 * relabelled as 24 kHz produced zero events on 4 of 5 sessions and a mangled
 * fragment on the fifth; a tau2 retail run scored 2/25 that way, answering 62 of
 * 171 user turns with an unresponsive period in 25 of 25 sessions.
 *
 * Pinning the rates and advertising them in the ready frame is what SHOULD have
 * covered this, and does for any client that captures off that frame (aai-ui
 * asks its AudioContext for the advertised rate and asserts it was granted).
 * But a client is free to ignore the frame — tau2's harness derives its send
 * rate from a module constant and treats the frame as a bare ack — and then no
 * number anywhere is wrong while every byte is. There is nothing later in the
 * session that can detect it, so it has to fail here.
 *
 * Returns an error message, or `undefined` when the rates are fine (including
 * when the client declared none, which means "tell me what to use").
 */
function assertHostRatesSupported(
  agent: AgentDef,
  msg: { sampleRate?: number | undefined; ttsSampleRate?: number | undefined },
): string | undefined {
  if (!usesAssemblyS2s(agent)) return;
  const rate = ASSEMBLYAI_S2S_SAMPLE_RATE;
  const bad = (["sampleRate", "ttsSampleRate"] as const).filter(
    (k) => msg[k] !== undefined && msg[k] !== rate,
  );
  if (bad.length === 0) return;
  return (
    `host-mode: this agent runs on the AssemblyAI Voice Agent API, which supports ${rate} Hz only, ` +
    `but the config frame declared ${bad.map((k) => `${k}=${String(msg[k])}`).join(", ")}. ` +
    `Send and expect ${rate} Hz PCM16, or omit the field to accept the rate in the config frame.`
  );
}

/**
 * Derive the S2S sample-rate config from a client's requested rates, falling
 * back to the defaults. The single `config` frame carries the client's
 * `sampleRate`/`ttsSampleRate` alongside the `host` block; honoring them keeps
 * the negotiated audio format consistent end-to-end.
 */
function s2sConfigFromHandshake(msg: {
  sampleRate?: number | undefined;
  ttsSampleRate?: number | undefined;
}): S2sConfig {
  return {
    ...DEFAULT_S2S_CONFIG,
    ...omitUndefined({ inputSampleRate: msg.sampleRate, outputSampleRate: msg.ttsSampleRate }),
  };
}

/**
 * Deferred host-mode session start.
 *
 * Attaches a one-shot listener for the first inbound text frame, validates it
 * as a host `config` handshake, and — when host mode is allowed — builds a
 * fresh single-use runtime whose tools are relayed to the client, then hands
 * the socket off to the normal `wireSessionSocket` flow via
 * `runtime.startSession`. Invalid, disallowed, or missing handshakes reject the
 * connection with a protocol error.
 *
 * @internal
 */
export function startHostSession(ws: SessionWebSocket, opts: StartHostSessionOptions): void {
  const log = opts.logger ?? consoleLogger;
  const makeRuntime = opts.createRuntime ?? createRuntime;
  let settled = false;

  const handshakeTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectHandshake(ws, log, "host-mode: timed out waiting for config frame");
  }, opts.handshakeTimeoutMs ?? DEFAULT_HOST_HANDSHAKE_TIMEOUT_MS);
  handshakeTimer.unref?.();

  // A socket that dies before any handshake must release the timer — left
  // armed it fires rejectHandshake against a dead socket later, logging a
  // misleading "handshake rejected" for a connection that simply went away.
  ws.addEventListener("close", () => {
    if (settled) return;
    settled = true;
    clearTimeout(handshakeTimer);
  });

  /** Runs once the handshake has been validated AND the env has resolved. */
  function startWithEnv(
    env: Record<string, string>,
    handshake: {
      host: HostConfig;
      sampleRate?: number | undefined;
      ttsSampleRate?: number | undefined;
    },
  ): void {
    // The env may have resolved after the socket died; a runtime built now
    // would wait forever for an `open` that never comes and leak its pool.
    if (ws.readyState !== WS_OPEN) return;

    if (!(opts.allowHost ?? isHostAllowed(env))) {
      rejectHandshake(ws, log, "host-mode is disabled on this server (AAI_ALLOW_HOST)");
      return;
    }

    const { host } = handshake;

    // Screened BEFORE the merge, and the gate above is checked against the
    // SERVER's env, never the merged one — a client must not be able to
    // approve its own connection by sending the flag as a "credential".
    const rejectedName = unknownCredentialName(host.credentials);
    if (rejectedName !== undefined) {
      rejectHandshake(ws, log, `host-mode: "${rejectedName}" is not a provider credential`);
      return;
    }
    const sessionEnv = withHostCredentials(env, host.credentials);

    const hostAgent = buildHostAgent(host, opts.baseAgent);
    const rateError = assertHostRatesSupported(hostAgent, handshake);
    if (rateError !== undefined) {
      rejectHandshake(ws, log, rateError);
      return;
    }

    const relay = createRelayExecuteTool({
      send: (e) => sendEvent(ws, e, log),
      timeoutMs: opts.relayTimeoutMs,
    });

    let runtime: ReturnType<typeof createRuntime>;
    try {
      runtime = makeRuntime({
        agent: hostAgent,
        env: sessionEnv,
        executeTool: relay.executeTool,
        toolSchemas: host.tools as ToolSchema[],
        onToolResult: relay.onToolResult,
        s2sConfig: s2sConfigFromHandshake(handshake),
        logger: log,
      });
    } catch (err) {
      relay.dispose();
      rejectHandshake(ws, log, `host-mode: failed to build runtime: ${errorMessage(err)}`);
      return;
    }

    ws.addEventListener("close", () => {
      relay.dispose();
      // The runtime is single-use — built for this connection alone — and
      // socket teardown only stops the session. shutdown() is what releases
      // runtime-owned resources (a DATABASE_URL-backed pg pool above all);
      // without it every host-mode connect/disconnect strands one pool in
      // the server process until Postgres runs out of connections.
      void runtime.shutdown().catch((err: unknown) => {
        log.warn("host-mode runtime shutdown failed", { error: errorMessage(err) });
      });
    });

    log.info("host-mode session starting", { tools: host.tools.length });
    // Pacing is the CLIENT'S declaration, and it defaults to PACED.
    //
    // Unpaced used to be the blanket default, reasoning that a host-mode client
    // is programmatic and therefore keeps its own clock. That conflates two
    // things: being programmatic does not mean consuming FASTER than the wall
    // clock, and only a client whose timeline runs ahead is starved by pacing.
    // For one that drains at 1x it is destructive — in S2S mode the service
    // synthesises a whole reply server-side and it arrives in one burst, so
    // unpaced relay grew the tau2 harness's backlog to MINUTES, and that
    // harness discards its buffer on barge-in: 36% of all agent speech was
    // destroyed unheard. Pacing keeps the backlog on this side, where
    // `PacedAudioSink.clear()` drops it on barge-in instead.
    //
    // So the client says. Omitted means the pacer's own real-time default (the
    // field is omitted rather than set, so nothing forks that default); `null`
    // means unpaced, for a harness that genuinely steps faster than real time.
    runtime.startSession(ws, {
      ...hostAudioLead(host.audioLeadMs),
      ...opts.startOpts,
    });
  }

  ws.addEventListener("message", (event: { data: unknown }) => {
    if (settled) return;
    const { data } = event;
    // The handshake is a JSON text frame; ignore any stray binary audio.
    if (typeof data !== "string") return;

    settled = true;
    clearTimeout(handshakeTimer);

    const parsed = safeJsonParse(data);
    if (parsed === undefined) {
      rejectHandshake(ws, log, "host-mode: first frame was not valid JSON");
      return;
    }

    const result = HostConfigMessageSchema.safeParse(parsed);
    if (!result.success) {
      rejectHandshake(ws, log, "host-mode: first frame was not a valid host config");
      return;
    }

    // The env may be a pending Vault fetch (see StartHostSessionOptions.env);
    // for a plain object this resolves on the next microtask, before any
    // further socket event can be delivered.
    // The trailing catch contains a synchronous throw out of startWithEnv
    // (or out of rejectHandshake itself — the logger is caller-injectable,
    // same reason s2s-transport wraps its handler): without it, that throw
    // is an unhandled rejection on the host, per handshake.
    void Promise.resolve(opts.env)
      .then(
        (env) => startWithEnv(env, result.data),
        (err: unknown) => {
          rejectHandshake(ws, log, `host-mode: failed to load agent env: ${errorMessage(err)}`);
        },
      )
      .catch((err: unknown) => {
        console.error(`host-mode: handshake failed: ${errorMessage(err)}`);
        try {
          ws.close?.(1011);
        } catch {
          // socket may already be closed
        }
      });
  });
}
