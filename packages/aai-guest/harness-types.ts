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

/**
 * The Standard Schema surface a tool's input schema exposes, narrowed to the one
 * method the harness calls.
 *
 * Structural rather than the SDK's `ToolInputSchema`, for the same reason the
 * rest of this file is: these types describe the harness↔bundle CONTRACT, and a
 * bundle carries its own SDK version. What the harness may rely on is the
 * Standard Schema method, which is versioned by the spec rather than by us.
 */
export type ToolInputSchemaLike = {
  "~standard": {
    validate(
      value: unknown,
    ):
      | { value: unknown; issues?: undefined }
      | { issues: readonly { readonly message: string }[] }
      | Promise<
          | { value: unknown; issues?: undefined }
          | { issues: readonly { readonly message: string }[] }
        >;
  };
};

/**
 * A tool as the harness reads one off a loaded bundle.
 *
 * Both field pairs are optional because the SDK accepts both spellings for one
 * major — `input`/`run` are canonical, `inputSchema`/`execute` the previous
 * names — and a bundle built against either SDK version has to load here. Read
 * them with {@link toolDefInput} / {@link toolDefRun}, never directly.
 *
 * `parameters?: { parse }` used to sit here in place of the schema, long after
 * the SDK removed that field: so the trial runner's only argument validation
 * was reading a key no tool has carried in a long time, and every trial ran
 * unvalidated.
 */
export type ToolDef = {
  description: string;
  input?: ToolInputSchemaLike;
  inputSchema?: ToolInputSchemaLike;
  run?(args: unknown, ctx: ToolContext): Promise<unknown> | unknown;
  execute?(args: unknown, ctx: ToolContext): Promise<unknown> | unknown;
};

/** The tool's input schema under either spelling. */
export function toolDefInput(def: ToolDef): ToolInputSchemaLike | undefined {
  return def.input ?? def.inputSchema;
}

/** The tool's handler under either spelling. */
export function toolDefRun(def: ToolDef): NonNullable<ToolDef["run"]> | undefined {
  return def.run ?? def.execute;
}

export type AgentDef = {
  name: string;
  systemPrompt: string;
  greeting: string;
  tools: Record<string, ToolDef>;
  state?: () => Record<string, unknown>;
  maxSteps?: number;
  /**
   * `"static"` when the agent serves a page rather than voice sessions — read
   * here so the harness can pass it to `createServer` (which then refuses the
   * voice surfaces and reports it in `/client-config`). Optional because this is
   * a MIRROR of the SDK's `AgentDef` and a bundle built with an older SDK simply
   * has none; absent reads as `"voice"`, as it does everywhere else.
   */
  page?: "voice" | "static";
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
  /**
   * The bundle's workflow engine, forwarded to the SDK's own `createServer` so
   * this guest serves the workflow HTTP API (`/workflows/*`).
   *
   * OPTIONAL because the contract is versioned additively and this arrived
   * late: a bundle built with an older SDK returns a two-method runtime, and the
   * API then answers 404 rather than failing the boot. Deliberately loose for
   * the same reason the two methods above are — the shapes belong to the
   * bundle's SDK, and the harness only hands this to `createServer`.
   */
  workflows?: unknown;
};

/**
 * The bundle's `__aaiCreateRuntime` export. The harness↔bundle contract,
 * kept deliberately tiny so it can stay stable across SDK versions:
 * `{ env, db?, runCode? }` in, `{ startSession, shutdown }` out.
 */
export type CreateGuestRuntime = (opts: {
  env: Record<string, string>;
  db?: DbAdapter;
  runCode?: (code: string) => Promise<string | { error: string }>;
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
