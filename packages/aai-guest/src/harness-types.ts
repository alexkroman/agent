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

// A `DbAdapter` — a minimal `Db`-shaped handle mirroring the SDK's — stood here,
// on both `ToolContext` and the bundle contract below. It is gone with `ctx.db`:
// the platform hands tool code no database, and nothing ever passed one through
// this contract anyway (it was declared and unused).

export type ToolContext = {
  env: Readonly<Record<string, string>>;
  /**
   * Per-call trial state. The trial runner (studio `test_agent`) ships the
   * state with each one-shot trial and stores the (possibly mutated) object
   * the response carries back — a real session's state lives in the embedded
   * runtime, not here.
   */
  state: Record<string, unknown>;
  /**
   * ctx.generate. Only the trial runner builds a `ToolContext`, and trials
   * don't run generation, so the harness supplies a rejecting stub — a real
   * session's ctx.generate comes from the embedded SDK runtime instead.
   */
  generate: () => Promise<never>;
  /**
   * ctx.delegate. Rejecting for the same reason `generate` is, and it matters
   * more here: a trial has no session, so a subagent run would spend real
   * tokens against a context that is thrown away when the trial returns.
   */
  delegate: () => Promise<never>;
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
  /**
   * `"static"` when the agent serves a page rather than voice sessions — read
   * here so the harness can pass it to `createRuntimeServer`, which then declines the
   * voice surfaces and reports it in `/client-config`. Optional because this is
   * a MIRROR of the SDK's `AgentDef` and a bundle built with an older SDK simply
   * has none; absent reads as `"voice"`, as it does everywhere else.
   */
  page?: "voice" | "static";
  /**
   * Which phone carriers may open a media stream on `WS /phone` — read here so
   * the harness can pass the declaration to `createRuntimeServer`, which serves
   * the route for exactly those carriers and refuses every other upgrade.
   *
   * Spelled out rather than imported for this file's stated reason (no
   * workspace imports), and optional for `page`'s: it MIRRORS the SDK's
   * `AgentDef`, and a bundle built with an older SDK carries none — which reads
   * as no carrier, the same refusal an explicit `false` makes. A carrier name a
   * newer SDK adds is carried at run time regardless, the bundle's agent being
   * asserted to this type rather than validated against it.
   */
  telephony?: boolean | readonly ("twilio" | "telnyx")[];
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
   * The bundle's `ctx.workflows`, forwarded to the SDK's own `createRuntimeServer` so
   * this guest serves the workflow HTTP API (`/workflows/*`).
   *
   * OPTIONAL because the harness↔bundle contract is versioned additively and
   * this arrived late: a bundle built with an older SDK returns a two-method
   * runtime, and the API then answers 404 rather than failing the boot.
   * Deliberately loose for the same reason the two methods above are — the shape
   * belongs to the bundle's SDK, and the harness only hands it back.
   */
  workflows?: unknown;
  /**
   * The bundle's `deliverWorkflow` — re-walk one run for a platform delivery.
   *
   * OPTIONAL for exactly the reason `workflows` above is: the harness↔bundle
   * contract is versioned additively, and a bundle built before the replay engine
   * returns a runtime without it. The delivery door then answers as it did
   * before — that bundle's runs are the DevKit's and its own world holds their
   * schedule, so there is nothing here for the platform to drive.
   *
   * This is what makes a DEPLOYED run's `ctx.sleep` come back: a guest's own
   * timers die with a sandbox that self-exits, so the platform's queue holds the
   * schedule and a due message boots the guest and lands here.
   */
  deliverWorkflow?: unknown;
};

/**
 * The bundle's `__aaiCreateRuntime` export. The harness↔bundle contract,
 * kept deliberately tiny so it can stay stable across SDK versions:
 * `{ env, runCode?, publicUrl? }` in, `{ startSession, shutdown }` out.
 *
 * Everything here is a CAPABILITY OR A FACT THE HARNESS ALONE HOLDS — that is
 * the membership rule, and what keeps the tininess a principle rather than a
 * number. `runCode` is the executor only a sandbox has; `publicUrl` is the URL
 * only the spawner knows, since a guest's own origin is a loopback port behind a
 * tunnel that changes on every respawn. Provider resolution, tool dispatch and
 * session state stay out, on the bundle's SDK's version.
 *
 * Additive-only, and every field OPTIONAL for the same reason: a bundle built
 * against an older SDK ignores what it does not read, and a bundle built against
 * a newer one receiving nothing degrades rather than failing boot (an absent
 * `publicUrl` makes `ctx.workflows.publicWebhookUrl` throw, which is the designed
 * answer). `GUEST_CONTRACT_VERSION` records each addition.
 */
export type CreateGuestRuntime = (opts: {
  env: Record<string, string>;
  runCode?: (code: string) => Promise<string | { error: string }>;
  publicUrl?: string;
}) => GuestRuntime;

/**
 * What the studio coding agent borrows from the harness itself: the two
 * capabilities `test_agent` is built out of, and the only two the harness hands
 * down to the tool layer.
 *
 * One declaration because it is ONE pair travelling one route —
 * `handleStudioRequest` → `createStudioAgent` → `createStudioTools` — and it had
 * been written out at all three, each with its own JSDoc, so a change to either
 * signature had three places to land and two places to be forgotten.
 */
export type HarnessBundleAccess = {
  /** The harness's own bundle loader (`loadBundle`). */
  loadBundle: (code: string) => Promise<{ config?: unknown }>;
  /** The harness's one-shot trial executor (`executeTool`). */
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
};

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
