// Copyright 2025 the AAI authors. MIT license.
/**
 * Public type declarations for the agent runtime.
 *
 * Split out of `runtime.ts` to keep that module focused on the
 * `createRuntime` implementation. All imports here are type-only.
 */

import type { AgentEnv } from "@alexkroman1/aai/host-internal";
import type { Db } from "@alexkroman1/aai/internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { ClientSink, ReadyConfig, SessionCommand } from "@alexkroman1/aai/protocol";
import type { SttProvider } from "@alexkroman1/aai/stt";
import type { TtsProvider } from "@alexkroman1/aai/tts";
import type { WorkflowClient } from "@alexkroman1/aai/workflow-api";
import type { HostGenerateFn } from "./generate.ts";
import type { HostAgentOptions } from "./host-agent-options.ts";
import type { S2sConfig } from "./runtime-config.ts";
import type { CreateS2sWebSocket } from "./s2s.ts";
import type { ServerSession } from "./session-core.ts";
import type { SessionEventStream } from "./session-event-stream.ts";
import type { ExecuteTool } from "./tool-executor.ts";
import type { CreateOpenaiRealtimeWebSocket } from "./transports/openai-realtime-transport.ts";
import type { JournalStore } from "./workflow/journal/types.ts";
import type { SessionWebSocket } from "./ws-handler.ts";

/** Per-session options passed to {@link AgentRuntime.startSession}. */
export type SessionStartOptions = {
  skipGreeting?: boolean;
  resumeFrom?: string;
  logContext?: Record<string, string>;
  onOpen?: () => void;
  onClose?: () => void;
  /**
   * Called with session ID after session cleanup, for guest state cleanup.
   * `sink` is the ending connection's own client sink; compare it against the
   * sink the latest `onSinkCreated` delivered before releasing per-session
   * state — a resume can register a NEW session under the same id while the
   * old one drains, and a bare keyed cleanup here would tear down the live
   * resumed session's state.
   */
  onSessionEnd?: (sessionId: string, sink?: ClientSink) => void;
  /** Called with session ID and client sink after session setup. Used by sandbox to route custom events. */
  onSinkCreated?: (sessionId: string, sink: ClientSink) => void;
  /**
   * Audio pacing lead for this session, in ms. The default suits a client that
   * plays audio in real time (a browser); pass `UNPACED_AUDIO_LEAD_MS` for a
   * programmatic client that buffers and meters playback itself.
   */
  audioLeadMs?: number;
};

/**
 * Per-session options for {@link connectSession}.
 *
 * @public
 */
export type SessionConnectOptions = Pick<
  SessionStartOptions,
  "skipGreeting" | "resumeFrom" | "logContext" | "onSessionEnd" | "audioLeadMs"
>;

/**
 * The input half of a session started with {@link connectSession}.
 *
 * Input sent while the session is still starting is buffered and replayed once
 * it is ready; input after the session has ended is dropped.
 *
 * @public
 *
 * @sealed
 */
export type SessionConnection = {
  /** The session's id — pass it back as `resumeFrom` to resume this conversation. */
  readonly id: string;
  /** The audio formats this session speaks — the same values `session.configured` carries. */
  readonly readyConfig: ReadyConfig;
  /** One chunk of user audio: PCM16 little-endian mono at `readyConfig.sampleRate`. */
  sendAudio(pcm16: Uint8Array): void;
  /**
   * One client command — `audio_ready`, `cancel`, `reset`, `playback_progress`
   * or `tool_result`. Validated exactly as a socket frame is; an invalid one is
   * logged and dropped.
   */
  sendCommand(command: SessionCommand): void;
  /**
   * Your end went away: stop the session and release it. Idempotent. The
   * runtime also calls this itself after it closes `sink` — a resume by
   * another connection, or a session that failed to start.
   */
  close(): void;
  /** Settles once the session has stopped and its cleanup has run. */
  readonly ended: Promise<void>;
};

/**
 * Common interface for agent runtimes.
 *
 * Implemented by {@link createRuntime} and the platform sandbox.
 */
export type AgentRuntime = {
  startSession(ws: SessionWebSocket, options?: SessionStartOptions): void;
  shutdown(): Promise<void>;
  readonly readyConfig: ReadyConfig;
  /**
   * `ctx.workflows` for this runtime — the same client tool code is given, and
   * what {@link createRuntimeServer} serves `/workflows/*` from. Undefined for an agent
   * that declares none, which is what makes that API answer 404 rather than
   * pretending to a surface the agent does not have.
   */
  readonly workflows?: WorkflowClient | undefined;
  /**
   * Re-walk one durable run's body, for a delivery that arrived from outside.
   *
   * `ctx.workflows.start` hands a run to a DISPATCHER and executes nothing, which
   * is what lets one engine serve every deployment. Where that dispatcher points
   * differs: `aai dev` and a self-hosted server run the delivery on the next turn
   * of the loop, and a deployed guest POSTs the platform's queue, which delivers
   * back to `POST /workflow-queue` — and THIS is what that route calls.
   *
   * It exists on the runtime rather than on {@link workflows} because it is not
   * something an agent's own code may do. A tool starting or cancelling a run is
   * ordinary; a tool re-walking one on demand would let a body's own step drive
   * its own replay, and the engine's idempotence is written for a queue rather
   * than for a caller.
   *
   * Undefined for an agent that declares no workflows, so a delivery to one
   * answers rather than throwing.
   *
   * **A delivery is AT-LEAST-ONCE and this is written for it.** Two overlapping
   * deliveries of one run are safe because the journal answers a settled step
   * from itself rather than because anything locks; what they cost is doing the
   * work twice, which is why a deployment has exactly one dispatcher.
   */
  readonly deliverWorkflow?: ((runId: string) => Promise<unknown>) | undefined;
  /**
   * This runtime's session event stream — what {@link createRuntimeServer} serves
   * `/session-events/:id` from, and what a resuming session reads its
   * conversation back out of.
   *
   * Optional because the platform sandbox runtime does not hold one: there, the
   * GUEST's own runtime owns the stream, and this facade only forwards sessions
   * to it. A server without one answers 503 rather than pretending to a record
   * it does not keep.
   */
  readonly sessionEvents?: SessionEventStream | undefined;
};

/**
 * Configuration for {@link createRuntime}.
 *
 * Configures the agent, environment, database, logging and provider triple;
 * the fields every way of running an agent shares are {@link HostAgentOptions}.
 * `providerEnv` defaults to {@link RuntimeOptions.env}, `logger` to the
 * console, and `runCode` is supplied only by the platform's guest harness.
 *
 * The testing and relay SEAMS — a WebSocket factory per S2S transport, a relay
 * `executeTool`/`toolSchemas` pair with its `onToolResult`, the sandbox's
 * `toolGuidance`, and the S2S endpoint and start deadline — are not here. They
 * were `@internal` members of this public type, reachable anyway because API
 * Extractor reads the tag at the declaration; they are `HostRuntimeOptions`
 * now, the move `generate` made first.
 *
 * @public
 */
export interface RuntimeOptions extends HostAgentOptions {
  /**
   * The agent's own env — what tool code sees as `ctx.env`. Typed
   * `AgentEnv`: a `withHostCredentialFallback` result (which may carry
   * host/shell credentials) is a compile error here — pass it as
   * {@link RuntimeOptions.providerEnv} instead.
   */
  env: AgentEnv;
  /**
   * SQL database backing the runtime's OWN two stores: session-slot storage
   * (`createRuntimeSessionState`) and the workflow run journal plus its
   * correlation key store (`selectJournal` / `selectKeyStore`). It is NOT
   * handed to tool code — there is no `ctx.db`, and a tool needing SQL brings
   * its own client. When omitted, the runtime connects one itself from
   * `DATABASE_URL` in the provider env (self-hosted `aai dev` parity with the
   * platform's database switch); with neither, both stores fall back to
   * process memory and a restart forgets them.
   */
  db?: Db | undefined;
  /**
   * Where this runtime's durable runs live, when nothing more durable wins.
   *
   * **STORAGE per PROCESS, CODE per BUILD.** A runtime is built once per
   * deployment everywhere except `aai dev`, which rebuilds one on every file
   * save so a save reloads the agent's code — and a rebuilt runtime rebuilt the
   * run store underneath it, because the engine defaults to a fresh
   * `createMemoryJournal()` when nobody hands it one. A run started before a save
   * was therefore gone after it, and `GET /workflows/runs/:id` answered 404 for a
   * run whose id the caller was still holding. It reads as the run having failed
   * rather than as the store having been replaced, which is the failure mode of
   * every default made at the definition site on a caller's behalf.
   *
   * A host that wants the runs to outlive a rebuild builds ONE of these at
   * process scope and passes it on every build — the engine still comes per
   * build, which is what keeps hot reload honest.
   *
   * **It only reaches the MEMORY arm.** The journal is chosen platform, then
   * postgres, then this — so supplying one cannot demote a deployed guest's
   * platform journal or an agent's own database to something that dies with the
   * process. The boot line names whichever actually won.
   *
   * **A run parked on `ctx.sleep` at the moment of a rebuild does WAKE.** It
   * used not to: the in-process dispatcher holds only timers it created itself,
   * so a rebuild discarded the schedule while leaving the journal intact, and
   * the run sat `running` forever — the same handover hole a process RESTART had
   * one level down, open in both places. `createInProcessWorkflowEngine`'s BOOT
   * SWEEP closed both, by reading `JournalStore.resumableRuns` at construction
   * and re-arming a delivery per run it still owes one; read that module's
   * "The timers die with the process, so the JOURNAL is re-read at boot" for the
   * bound, the stagger, and why an injected dispatcher gets no sweep. A journal
   * that cannot enumerate its resumable runs is WARNED about at boot rather than
   * silently forgotten.
   *
   * **The remainder, stated because it is the honest one:** this is a BOOT
   * sweep, not a poll. A delivery lost while the process stays UP — a journal
   * that was briefly unreachable — waits for the next boot; there is no `wakeUp`
   * rescue path for it (an elapsed deadline is not a wait `wakeSleeps` may stop)
   * and nothing repeats the pass.
   */
  journal?: JournalStore | undefined;
  /**
   * The base URL this agent is reachable at from OUTSIDE — origin plus, on the
   * managed platform, the agent's slug (`https://<platform>/<slug>`).
   *
   * Read by exactly one thing: `ctx.workflows.publicWebhookUrl(token)`, the URL a
   * durable run hands a third party. It has to be told rather than derived,
   * because nothing inside the process knows it — a deployed agent's own origin
   * is a `localhost` port inside a sandbox whose tunnel changes on every
   * respawn, which is precisely why the DevKit's `hook.url` is unusable off-box.
   *
   * Each deployment supplies its own: the platform's broker bakes
   * `AAI_PUBLIC_BASE_URL` into the guest's exec env and the harness passes it
   * through, `server.mjs` passes `PUBLIC_URL`, and `aai dev` passes its own
   * origin. Absent, `publicWebhookUrl` throws naming this option — which is the
   * intended behaviour, not a gap: a `localhost` URL handed to a payment provider
   * fails weeks later, at them.
   */
  publicUrl?: string | undefined;
  /**
   * Maximum time in milliseconds to wait for sessions to stop during
   * {@link AgentRuntime.shutdown | shutdown()}. Defaults to `30_000` (30 s).
   */
  shutdownTimeoutMs?: number | undefined;
  /**
   * STT provider descriptor ({@link SttProvider}). Must be set together with
   * `llm` and `tts` to route sessions through the pipeline path; leave all
   * three unset to fall back to the agent's own provider fields (which
   * default to the all-AssemblyAI pipeline when the agent declares none).
   */
  stt?: SttProvider | undefined;
  /** LLM provider descriptor, from a factory like `llm({ provider: "anthropic", ... })`. */
  llm?: LlmProvider | undefined;
  /** TTS provider descriptor ({@link TtsProvider}). */
  tts?: TtsProvider | undefined;
}

/**
 * The runtime's HOST-ONLY options — {@link RuntimeOptions} plus the seams no
 * embedder is promised: the two S2S WebSocket factories, the S2S endpoint
 * and start deadline, the relay tool pair (`executeTool` + `toolSchemas`, and
 * `onToolResult` settling it) that host mode and the sandbox run on, the
 * sandbox's `toolGuidance`, and `generate`.
 *
 * Not exported from any published subpath. `generate` was a public
 * `RuntimeOptions` member tagged `@internal`, which is the shape the root
 * barrel's zero-`@internal` ratchet exists to refuse: API Extractor reads the
 * tag at the declaration and the member stayed in every embedder's
 * autocomplete, and the rest followed it. Their callers are this package's
 * own — host mode (`host-mode.ts`), the eval harness (`eval/session.ts`) and
 * the specs — each reaching `createRuntimeWithSeams` by a relative import, so
 * the seams keep working and nothing outside the package can name them.
 *
 * @internal
 */
export type HostRuntimeOptions = RuntimeOptions & {
  /**
   * Custom WebSocket factory for the S2S connection (testing seam).
   * @internal
   */
  createWebSocket?: CreateS2sWebSocket | undefined;
  /**
   * Custom WebSocket factory for the OpenAI Realtime connection (testing seam).
   * @internal
   */
  createOpenaiRealtimeWebSocket?: CreateOpenaiRealtimeWebSocket | undefined;
  /** S2S endpoint URL and audio sample rates. Defaults to `DEFAULT_S2S_CONFIG`. */
  s2sConfig?: S2sConfig | undefined;
  /**
   * Timeout in ms for `session.start()` (S2S connection setup).
   * Defaults to 10 000 (10 s).
   */
  sessionStartTimeoutMs?: number | undefined;
  /**
   * Override tool execution. When provided, `createRuntime` skips building
   * in-process tool definitions and uses this function instead. Used by the
   * platform sandbox to RPC tool calls to the isolate.
   *
   * **Paired with {@link HostRuntimeOptions.toolSchemas}, and `createRuntime` THROWS
   * on half a pair** — see `setupTools` in `runtime-tools.ts` for what the old
   * silent fallback cost.
   *
   * @internal
   */
  executeTool?: ExecuteTool | undefined;
  /**
   * Override tool schemas sent to the S2S API. Required when `executeTool`
   * is provided (the host doesn't have the tool definitions to derive schemas),
   * and REFUSED without it — the two are one option, and `createRuntime` throws
   * naming whichever is absent rather than quietly running the other tool path.
   * `toolSchemas: []` is the legal spelling of a relay that advertises no tools.
   *
   * @internal
   */
  toolSchemas?: ToolSchema[] | undefined;
  /**
   * Host/relay mode hook. When set, inbound `tool_result` frames are routed to
   * this handler (which settles the relay's pending call) and the session skips
   * its own `tool_call` emit since the relay `executeTool` emits it. Paired with
   * a relay `executeTool` + `toolSchemas`. See host-mode.ts.
   */
  onToolResult?:
    | ((message: { toolCallId: string; result: string; error?: string }) => void)
    | undefined;
  /** System prompt guidance for builtin tools. Passed through in sandbox mode. */
  toolGuidance?: string[] | undefined;
  /**
   * Override what tool code calls as `ctx.generate`.
   *
   * @internal A testing seam, shaped like `executeTool` and `createWebSocket`.
   * It exists because `ctx.generate` resolves the agent's LLM DESCRIPTOR into a
   * model of its own (`setupGenerate` → `createGenerateFn` → `resolveLlm`), so a
   * scripted provider hands it a SECOND instance walking that script from the
   * start, in parallel with the turn's. One script cannot serve both: element 0
   * has to be the turn's first move AND the first `generate` answer at once.
   * With this, an eval scripts the two independently.
   */
  generate?: HostGenerateFn | undefined;
};

/**
 * The seal on a {@link Runtime}.
 *
 * TYPE-ONLY — there is no value at run time, so an object literal cannot carry
 * the key and only {@link createRuntime} mints a `Runtime`. That is the point:
 * a handle a caller RECEIVES may grow a member in a minor release without
 * breaking anybody, because nobody outside this package can have written one by
 * hand. A double for a server spec implements `SessionRuntime`, which is what
 * `createRuntimeServer` takes, and is not sealed.
 *
 * @public
 */
export declare const runtimeBrand: unique symbol;

/**
 * The agent runtime returned by {@link createRuntime}.
 *
 * Satisfies {@link AgentRuntime} for use by transport code. A session over
 * your OWN audio I/O is {@link connectSession}, a free function over this
 * handle rather than a method on it.
 *
 * @sealed Only {@link createRuntime} produces one — see {@link runtimeBrand}.
 *
 * @public
 */
export type Runtime = AgentRuntime & {
  /** The seal — see {@link runtimeBrand}. */
  readonly [runtimeBrand]: true;
};

/**
 * A {@link Runtime} plus the lower-level handles only this package's own code
 * reaches: running one tool, the schemas it advertises, and creating a session
 * for a client sink directly rather than over a socket.
 *
 * They were members of the public `Runtime`, used by nothing outside this
 * package's specs, and a received handle's member is a promise — so they moved
 * to the one type {@link createRuntimeWithSeams} returns. `createRuntime` hands
 * back the same object typed as `Runtime`; a session over your OWN I/O is
 * {@link connectSession}.
 *
 * @internal
 */
export type HostRuntime = Runtime & {
  /** Execute a named tool with the given args, returning a JSON result string. */
  executeTool: ExecuteTool;
  /** Tool schemas registered with the S2S API (custom + built-in). */
  toolSchemas: ToolSchema[];
  /** Create a new voice session for a connected client (lower-level than startSession). */
  createSession(options: {
    id: string;
    agent: string;
    client: ClientSink;
    skipGreeting?: boolean;
  }): ServerSession;
};
