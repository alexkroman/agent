// Copyright 2025 the AAI authors. MIT license.
//
// Shared type definitions for the Node guest harness.
//
// Split out of `harness.ts` to keep that entrypoint focused on the
// dispatch loop. Like the harness, this file has ZERO workspace imports —
// it is bundled into the self-contained guest artifact.

// ---- Tool / agent shapes ----------------------------------------------------

export type Message = {
  role: "user" | "assistant" | "tool";
  content: string;
};

// Minimal Db-shaped adapter passed to tool contexts (mirrors the SDK's `Db`)
export type DbAdapter = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
};

export type ToolContext = {
  env: Readonly<Record<string, string>>;
  /**
   * Per-call trial state. The trial runner (studio `test_agent`) ships the
   * state with each one-shot trial and stores the (possibly mutated) object
   * the response carries back — a real session's state lives in the embedded
   * runtime, not here.
   */
  state: Record<string, unknown>;
  /** App database. Accessing it with storage disabled throws guidance. */
  db: DbAdapter;
  /**
   * ctx.generate. Only the trial runner builds a `ToolContext`, and trials
   * don't run generation, so the harness supplies a rejecting stub — a real
   * session's ctx.generate comes from the embedded SDK runtime instead.
   */
  generate: () => Promise<never>;
  sessionId: string;
  messages: readonly Message[];
  send(event: string, data: unknown): void;
};

export type ToolDef = {
  description: string;
  parameters?: { parse(args: unknown): unknown };
  execute(args: unknown, ctx: ToolContext): Promise<unknown> | unknown;
};

export type AgentDef = {
  name: string;
  systemPrompt: string;
  greeting: string;
  tools: Record<string, ToolDef>;
  state?: () => Record<string, unknown>;
  maxSteps?: number;
};

// ---- Bundle-shipped runtime --------------------------------------------------

/**
 * The session runtime a worker bundle constructs for itself — the return
 * value of its `__aaiCreateRuntime` export, backed by the SDK version the
 * bundle was BUILT with (bundled in by the CLI's worker wrapper), never by
 * an SDK the harness ships. Deliberately loose: the harness only drives the
 * two-method surface, and the ws/opts shapes belong to the bundle's SDK.
 */
export type GuestRuntime = {
  startSession(ws: unknown, opts: unknown): void;
  shutdown(): Promise<void>;
};

/**
 * The bundle's `__aaiCreateRuntime` export. The harness↔bundle contract,
 * kept deliberately tiny so it can stay stable across SDK versions:
 * `{ env, db?, runCode? }` in, `{ startSession, shutdown }` out.
 */
/**
 * The shape the SDK's `AnalyticsSink` presents to the harness: one method
 * taking one event. Only the fields the harness can vouch for are named —
 * the SDK owns the rest of the event.
 */
export type AnalyticsSinkLike = {
  record(event: { ts: number; sessionId: string; kind: string; turn: number }): void;
};

export type CreateGuestRuntime = (opts: {
  env: Record<string, string>;
  db?: DbAdapter;
  runCode?: (code: string) => Promise<string | { error: string }>;
  /**
   * Where the runtime records session analytics.
   *
   * MIRRORED rather than imported, like {@link DbAdapter} above and for the
   * same reason — this file takes no workspace imports. It is deliberately
   * not `unknown`: old-bundle compatibility is a RUNTIME property (an older
   * `createRuntime` ignores the extra key, because the wrapper spreads its
   * opts), so nothing is bought by discarding the type on the harness side —
   * and the harness CONSTRUCTS this value, which is the line the file's own
   * doc draws between `db` and the values it merely forwards.
   *
   * Untyped, renaming `record` would type-check everywhere and leave every
   * deployed agent silently recording nothing — indistinguishable, in the
   * pane, from an agent nobody called.
   */
  analytics?: AnalyticsSinkLike;
}) => GuestRuntime;

// ---- JSON-RPC 2.0 message shapes --------------------------------------------

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
