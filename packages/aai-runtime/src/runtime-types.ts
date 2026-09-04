// Copyright 2025 the AAI authors. MIT license.
/**
 * Public type declarations for the agent runtime.
 *
 * Split out of `runtime.ts` to keep that module focused on the
 * `createRuntime` implementation. All imports here are type-only.
 */

import type { AgentDef } from "@alexkroman1/aai";
import type { AgentEnv, ProviderEnv } from "@alexkroman1/aai/host-internal";
import type { Db } from "@alexkroman1/aai/internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { ClientSink, ReadyConfig } from "@alexkroman1/aai/protocol";
import type { SttProvider } from "@alexkroman1/aai/stt";
import type { TtsProvider } from "@alexkroman1/aai/tts";
import type { WorkflowClient } from "@alexkroman1/aai/workflow-api";
import type { HostGenerateFn } from "./generate.ts";
import type { Logger, S2sConfig } from "./runtime-config.ts";
import type { CreateS2sWebSocket } from "./s2s.ts";
import type { ServerSession } from "./session-core.ts";
import type { SessionEventStream } from "./session-event-stream.ts";
import type { ExecuteTool } from "./tool-executor.ts";
import type { CreateOpenaiRealtimeWebSocket } from "./transports/openai-realtime-transport.ts";
import type { JournalStore } from "./workflow-journal-types.ts";
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
 * Common interface for agent runtimes.
 *
 * Implemented by {@link createRuntime} and the platform sandbox.
 */
export type AgentRuntime = {
  startSession(ws: SessionWebSocket, opts?: SessionStartOptions): void;
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
 * Configures the agent, environment, database, logging, and S2S connection.
 *
 * @public
 */
export type RuntimeOptions = {
  agent: AgentDef;
  /**
   * The agent's own env — what tool code sees as `ctx.env`. Typed
   * `AgentEnv`: a `withHostCredentialFallback` result (which may carry
   * host/shell credentials) is a compile error here — pass it as
   * {@link RuntimeOptions.providerEnv} instead.
   */
  env: AgentEnv;
  /**
   * Environment used to resolve provider credentials (STT/TTS/LLM).
   * Defaults to {@link RuntimeOptions.env}.
   *
   * Exists so a self-hosted caller can let shell-exported credentials reach
   * the provider resolvers without also placing them in `ctx.env`, where agent
   * tool code could read them and come to depend on host-level variables that
   * do not exist in production. The platform passes neither — it resolves
   * everything from the agent's own stored env.
   */
  providerEnv?: ProviderEnv | undefined;
  /**
   * SQL database exposed to tool code as `ctx.db`. When omitted, the runtime
   * connects one itself from `DATABASE_URL` in the provider env (self-hosted
   * `aai dev` parity with the platform's database switch); with neither,
   * `ctx.db` access throws.
   */
  db?: Db | undefined;
  /**
   * `ctx.workflows` for this runtime, supplied rather than built.
   *
   * Defaults to the client `buildWorkflowClient` assembles over the Workflow
   * DevKit, which is what every deployment wants. It is overridable for the one
   * caller that has no DevKit to assemble over: an EVAL drives a
   * `"use workflow"` body imported through a test runner, where the compiler's
   * transform never ran, so `def.run.workflowId` is absent and the real adapter
   * cannot start anything. `openEvalSession` passes the in-process client
   * `openEvalWorkflows` builds (`eval/workflows.ts`) so a tool that calls
   * `ctx.workflows.start` runs at all.
   *
   * A seam rather than a flag, and the same shape as `createWebSocket` beside
   * it: what is replaced is the ENGINE under the client, so everything above it
   * — the schema validation, the name mapping, the correlation-key index, the
   * snapshot union — is the code a deployment runs.
   *
   * @internal
   */
  workflows?: WorkflowClient | undefined;
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
   * Custom WebSocket factory for the S2S connection (testing seam).
   * @internal
   */
  createWebSocket?: CreateS2sWebSocket | undefined;
  /**
   * Custom WebSocket factory for the OpenAI Realtime connection (testing seam).
   * @internal
   */
  createOpenaiRealtimeWebSocket?: CreateOpenaiRealtimeWebSocket | undefined;
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
  /** Structured logger for runtime and session logs. Defaults to the console. */
  logger?: Logger | undefined;
  /** S2S endpoint URL and audio sample rates. Defaults to `DEFAULT_S2S_CONFIG`. */
  s2sConfig?: S2sConfig | undefined;
  /**
   * Timeout in ms for `session.start()` (S2S connection setup).
   * Defaults to 10 000 (10 s).
   */
  sessionStartTimeoutMs?: number | undefined;
  /**
   * Maximum time in milliseconds to wait for sessions to stop during
   * {@link AgentRuntime.shutdown | shutdown()}. Defaults to `30_000` (30 s).
   */
  shutdownTimeoutMs?: number | undefined;
  /**
   * Override tool execution. When provided, `createRuntime` skips building
   * in-process tool definitions and uses this function instead. Used by the
   * platform sandbox to RPC tool calls to the isolate.
   *
   * **Paired with {@link RuntimeOptions.toolSchemas}, and `createRuntime` THROWS
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
    | ((msg: { toolCallId: string; result: string; error?: string }) => void)
    | undefined;
  /** System prompt guidance for builtin tools. Passed through in sandbox mode. */
  toolGuidance?: string[] | undefined;
  /**
   * Override the fetch implementation used by built-in tools (web_search,
   * visit_webpage, get_page_design, fetch_json). Defaults to `builtinFetch()`:
   * SSRF-screened unless the spawner declared a real container around the
   * process (`AAI_SANDBOX_CONTAINED=1`), in which case the sandbox is the
   * boundary and the screen is skipped. Override only in tests.
   */
  fetch?: typeof globalThis.fetch | undefined;
  /**
   * In-sandbox executor for the `run_code` builtin. Only the platform's
   * guest harness provides one — it runs inside the Modal sandbox, which is
   * the security boundary. Without it, run_code refuses to evaluate code in
   * this process (the self-hosted guard).
   */
  runCode?: ((code: string) => Promise<string | { error: string }>) | undefined;
  /**
   * Per-tool-call deadline for this runtime's sessions. Defaults to
   * `TOOL_EXECUTION_TIMEOUT_MS` (30s), which is a VOICE-turn budget: a caller
   * waiting on speech has left by then.
   *
   * It is an option because that budget is not universal, and the tool executor
   * has always accepted one — `text-agent.ts` passes `toolTimeoutMs` and the
   * SESSION path passed nothing, so a session's 30s was unreachable from any
   * caller. A `support-line`-shaped tool (a graded retrieval loop, up to eleven
   * sequential model calls, measured at 22-30s against ~10x gateway variance)
   * therefore times out in a way its author cannot fix from the agent
   * definition. Raising it trades a voice-turn promise for a tool that finishes;
   * that is the caller's trade to make, not this file's.
   */
  toolTimeoutMs?: number | undefined;
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
  /**
   * STT provider descriptor ({@link SttProvider}). Must be set together with
   * `llm` and `tts` to route sessions through the pipeline path; leave all
   * three unset to fall back to the agent's own provider fields (which
   * default to the all-AssemblyAI pipeline when the agent declares none).
   */
  stt?: SttProvider | undefined;
  /** LLM provider descriptor, from a factory like `anthropicLlm(...)`. */
  llm?: LlmProvider | undefined;
  /** TTS provider descriptor ({@link TtsProvider}). */
  tts?: TtsProvider | undefined;
};

/**
 * The agent runtime returned by {@link createRuntime}.
 *
 * Satisfies {@link AgentRuntime} for use by transport code, and also exposes
 * lower-level helpers (`executeTool`, `toolSchemas`, `createSession`) for
 * testing and advanced usage.
 *
 * @public
 */
export type Runtime = AgentRuntime & {
  /** Execute a named tool with the given args, returning a JSON result string. */
  executeTool: ExecuteTool;
  /** Tool schemas registered with the S2S API (custom + built-in). */
  toolSchemas: ToolSchema[];
  /** Create a new voice session for a connected client (lower-level than startSession). */
  createSession(opts: {
    id: string;
    agent: string;
    client: ClientSink;
    skipGreeting?: boolean;
  }): ServerSession;
};
