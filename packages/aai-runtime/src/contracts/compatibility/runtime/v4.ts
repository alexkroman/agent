// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:runtime` epoch 4.
 *
 * A host FILLING the runtime's replaceable slots — its own tool executor, its
 * own `run_code` sandbox — and then calling through the `Runtime` it got back.
 * That is the half `v3.ts` does not reach: it builds the ordinary runtime and
 * starts a session on it, where this is what an embedder copies when the agent
 * runs here and the tools do not. Written the way it was authored at epoch 4,
 * and it must keep compiling for as long as that epoch is advertised as
 * supported.
 *
 * ## What moved, and why epoch 4 survives it
 *
 * Epoch 5 added an optional `journal` to `RuntimeOptions` — a host-supplied
 * `JournalStore`, the durable-run journal the replay engine walks. Until then
 * the runtime built its own from a `DATABASE_URL` or kept runs in memory, so a
 * host that already owns a database had no way to hand one over.
 *
 * Adding an OPTIONAL member to a bag the caller SUPPLIES is not breaking,
 * which is what makes this a retain: the bag below is still a legal
 * `RuntimeOptions`, and a host that names no `journal` gets the runtime it
 * always had.
 *
 * **The direction that WOULD break is a REQUIRED member on that bag**, and the
 * near miss is worth recording: `journal`'s type is a fifteen-method store, so
 * had it landed required, every host assembling these options would owe an
 * implementation of the whole replay engine's persistence before it could
 * compile. Optional is what makes that a feature rather than a migration.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 4 has to be dropped with a reason.
 */

import { agent } from "@alexkroman1/aai";
import {
  createRuntime,
  type ExecuteTool,
  type ExecuteToolOptions,
  type RunCodeExecutor,
  type Runtime,
  type RuntimeOptions,
  type SessionStartOptions,
  type SessionWebSocket,
  type SkipGreeting,
} from "../../../runtime-barrel.ts";

/** ── EDIT: the agent this host runs. ───────────────────────────────────── */
const definition = agent({
  name: "order-desk",
  systemPrompt: "You take pizza orders. Confirm the address before finishing.",
  greeting: "Order desk, what can I get you?",
});

/**
 * ── EDIT: where a tool call actually runs. ───────────────────────────────
 *
 * The slot exists because a tool need not run in this process: a platform
 * guest executes it in a sandbox, and a host embedding the session core may
 * already have its own dispatcher. Filling it replaces the runtime's own
 * executor wholesale, so this function owns everything a tool call is —
 * including refusing an unknown name, which the runtime would otherwise have
 * done.
 *
 * Four things about the signature are load-bearing, and all four are here
 * because the transports call through this type rather than through a class:
 *
 * - It returns a STRING. A tool's result goes back to the model as text, so
 *   the serialization decision is the executor's and not the caller's.
 * - A FAILURE the model should recover from is a returned string too, not a
 *   throw: a thrown error ends the turn, where a returned one lets the model
 *   apologise or try another tool.
 * - `messages` is the transcript so far, for an executor that needs context
 *   the arguments do not carry.
 * - `opts.signal` is the turn's abort signal, and honouring it is what makes
 *   barge-in cheap: a caller who interrupted is not waiting for this.
 */
export const executeTool: ExecuteTool = async (name, args, sessionId, messages, opts) => {
  const options: ExecuteToolOptions = { ...opts };
  if (options.signal?.aborted) return "cancelled";
  if (name !== "lookup_order") return `No such tool: ${name}`;
  const id = typeof args.orderId === "string" ? args.orderId : "";
  if (!id) return "I need an order id to look that up.";
  // `toolCallId` correlates a result with the call the model made, which is
  // what lets two concurrent calls to the same tool be told apart.
  void options.toolCallId;
  void sessionId;
  // Optional, and reading it as though it were not is the mistake this line
  // exists to have already made: a transport that carries no transcript omits
  // it entirely.
  void messages?.length;
  return JSON.stringify({ orderId: id, status: "out for delivery" });
};

/**
 * ── EDIT: your own sandbox for the built-in `run_code` tool. ─────────────
 *
 * The union return is the contract and not a convenience: `{ error }` is code
 * that FAILED, which the model is meant to read and correct, where a rejected
 * promise is the sandbox itself being broken. Collapsing the two loses the
 * distinction the model needs.
 *
 * A host that fills this owes the isolation. Nothing above this line is a
 * security boundary — the container is — so an executor that reaches for
 * `eval` has published this process to whatever the model was persuaded to
 * write.
 */
export const runCode: RunCodeExecutor = async (code) => {
  if (code.length > 10_000) return { error: "Snippet too long." };
  return { error: "This deployment runs no code." };
};

/**
 * ── EDIT: the credentials, and where they may be read. ───────────────────
 *
 * `env` and `providerEnv` are different questions: `env` is what a tool sees
 * as `ctx.env`, and a provider credential goes in `providerEnv` so a container
 * can pass one without it becoming readable by tool code.
 */
const options: RuntimeOptions = {
  agent: definition,
  env: {},
  providerEnv: { ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "" },
  executeTool,
  runCode,
  toolTimeoutMs: 30_000,
};

/**
 * `Runtime`, not `AgentRuntime`, and the difference is what a host may reach.
 *
 * `createRuntime` returns the wider one: `AgentRuntime` is the session-facing
 * surface a server is handed (`startSession`, `shutdown`), and `Runtime` adds
 * the two things a host that owns its own transport needs — the executor to
 * call and the schemas to advertise. `v3.ts` deliberately narrows to the
 * former; this file is the reason the latter is on the capability.
 */
const runtime: Runtime = createRuntime(options);

/**
 * Advertise the tools to something that is not this runtime's own transport —
 * a text channel, an evaluation harness, another model's tool loop.
 *
 * Read off the runtime rather than rebuilt from the agent definition, because
 * the runtime is what applied discovery: a tool is declared by its FILE, so a
 * list assembled by hand is a list that goes stale the moment somebody adds
 * one.
 */
export function toolNames(): string[] {
  return runtime.toolSchemas.map((schema) => schema.name);
}

/** Call a tool from outside a session — the `Runtime` half in one line. */
export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  return await runtime.executeTool(name, args);
}

/**
 * Decide the greeting, and resolve it at the moment it would fire.
 *
 * A thunk rather than a boolean because the answer is not known when a
 * transport is built: `?sessionId=` suppresses the greeting on the id's mere
 * presence, and whether that resume recovered anything is only known once the
 * event log and the slot store have been read.
 *
 * Resolved by hand here, which is a real limitation of this capability rather
 * than a gap in the example: `SkipGreeting` is contracted and the one-line
 * reader that goes with it is not, so a host owes the `typeof` itself — and a
 * site that forgets the CALL tests a function for truthiness and silences
 * every greeting, which is a mute agent rather than an error.
 */
export function startOptions(resumed: () => boolean): SessionStartOptions {
  const skip: SkipGreeting = resumed;
  return {
    skipGreeting: typeof skip === "function" ? skip() : skip,
    logContext: { deployment: "self-hosted" },
  };
}

/** Start one session on a socket this host already accepted. */
export function serve(ws: SessionWebSocket, resumed: () => boolean): void {
  runtime.startSession(ws, startOptions(resumed));
}

/** ── EDIT: the shutdown your process already has. ───────────────────────── */
export async function stop(): Promise<void> {
  await runtime.shutdown();
}
