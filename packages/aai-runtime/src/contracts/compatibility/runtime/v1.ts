// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring template: `aai-runtime:runtime` epoch 1.
 *
 * Building the thing that runs an agent definition and starting one session on
 * it, written the way a host authored it at epoch 1. It must keep compiling for
 * as long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 1 survives it
 *
 * `HostGenerateFn` — the type {@link RuntimeOptions.generate} is, and which
 * this capability's report carries as a forgotten declaration because a public
 * option references it — grew an optional `onUsage` in its CALL-OPTIONS bag, so
 * `ctx.generate` reports its tokens to the session's usage meter. Every arm of
 * that is additive, and both directions still assign: a host that CALLS a
 * generate fn may pass the new field or not, and a host that SUPPLIES one — the
 * interesting direction, and the one this file takes — is written against the
 * options it reads and stays assignable when the caller's bag gains a field it
 * ignores. That is the widening, and it is why this is a retain rather than a
 * drop.
 *
 * `runtime.ts` also reached the 500-line source cap and moved its session
 * controls to `runtime-session-controls.ts` with behaviour unchanged. A module
 * split behind an unchanged signature is exactly what a roll-call template is
 * for: nothing below names a file, so nothing below notices.
 *
 * The direction that WOULD break is the bag LOSING a field — `signal`, which
 * the `generate` below reads — or a new REQUIRED member on `RuntimeOptions`,
 * which is an obligation on the host rather than a gift to it. Adding to a bag
 * the caller fills is safe; taking from it, or demanding more of the caller, is
 * not.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 1 has to be dropped with a reason.
 *
 * @module
 */

import { agent } from "@alexkroman1/aai";
import {
  type AgentRuntime,
  createRuntime,
  type ExecuteTool,
  type ExecuteToolOptions,
  type RunCodeExecutor,
  type Runtime,
  type RuntimeOptions,
  rejectingRuntime,
  type SessionRuntime,
  type SessionStartOptions,
  type SkipGreetingOption,
} from "../../../runtime-barrel.ts";

/**
 * The agent this runtime runs.
 *
 * EDIT THIS. Everything below is wiring; this is the agent.
 */
const orders = agent({
  name: "Orders Desk",
  systemPrompt: "Look an order up before you say anything about it.",
  greeting: "Orders desk — what can I look up for you?",
  maxSteps: 4,
});

/**
 * ── EDIT: what this host supplies the runtime. ──────────────────────────
 *
 * `agent` and `env` are the required pair. Everything else is a seam a host
 * fills when it has something better than the default — a credential source
 * that is not the agent's own env, a `runCode` executor, a bounded `fetch`, a
 * `generate` of its own. A host that fills none of them still gets a working
 * runtime, which is the property this shape is for.
 */
const OPTIONS: RuntimeOptions = {
  agent: orders,
  env: { ASSEMBLYAI_API_KEY: "not-a-real-key" },
  // EDIT: a host that meters, caches or routes `ctx.generate` supplies its own.
  // It names `signal` and nothing else in the call-options bag, which is epoch
  // 1's whole promise about that bag — and is what keeps it assignable when the
  // bag gains a field (`onUsage`) an epoch-1 host never heard of.
  generate: async (options, callOptions) => {
    if (callOptions?.signal?.aborted === true) throw new Error("generate: aborted");
    return { text: `answer for: ${options.prompt}` };
  },
};

/** The runtime itself. One per deployment, reused across every session. */
export function runtimeFor(options: RuntimeOptions = OPTIONS): AgentRuntime {
  return createRuntime(options);
}

/**
 * ── EDIT: how a session is started. ─────────────────────────────────────
 *
 * `startSession` is what a transport calls once it holds a socket: the options
 * carry what is true of THIS session rather than of the deployment — whether
 * the caller has already heard the greeting, which session to resume from,
 * what to log it under. It returns nothing, because the socket is the handle.
 */
export function startSession(
  runtime: SessionRuntime,
  ws: Parameters<SessionRuntime["startSession"]>[0],
  options: SessionStartOptions = {},
): void {
  runtime.startSession(ws, options);
}

/**
 * ── EDIT: whether this caller has already heard the greeting. ───────────
 *
 * A predicate rather than a boolean is the interesting arm: a resume decides
 * per connection, and the runtime asks at the moment it would speak rather
 * than at the moment the option was built.
 */
export const skipGreetingWhenResuming: SkipGreetingOption = () => true;

/**
 * ── EDIT: what this host does when it cannot serve. ─────────────────────
 *
 * `rejectingRuntime` is the honest answer to a deployment that booted without
 * what it needs — a missing credential, an agent that failed to load. It
 * satisfies the same interface and refuses every session with the reason, so
 * the failure surfaces at the connection rather than as a runtime that looks
 * healthy and answers nothing.
 */
export function unavailable(reason: string): SessionRuntime {
  return rejectingRuntime(reason);
}

/**
 * ── EDIT: running a tool outside a session. ─────────────────────────────
 *
 * {@link Runtime} is {@link AgentRuntime} plus the two things a HARNESS needs
 * and a transport does not — the tool entry point and the schemas registered
 * with it — which is what lets a platform execute one tool call on its own
 * without standing a session up.
 */
export async function callTool(
  runtime: Runtime,
  name: string,
  args: Readonly<Record<string, unknown>>,
  options?: ExecuteToolOptions,
): Promise<string> {
  const execute: ExecuteTool = runtime.executeTool;
  return await execute(name, args, undefined, undefined, options);
}

/** The names this runtime advertises to an S2S provider. */
export function toolNamesOf(runtime: Runtime): readonly string[] {
  return runtime.toolSchemas.map((schema) => schema.name);
}

/**
 * ── EDIT: what backs the `run_code` builtin. ────────────────────────────
 *
 * Without one the builtin registers and permanently REFUSES, which is what
 * happens off-platform: the container is the security boundary and nothing
 * here pretends otherwise. A host that has its own isolate supplies this.
 */
export const refusingRunCode: RunCodeExecutor = async () => ({
  error: "run_code needs an executor this deployment does not have",
});
