// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring template: `aai-runtime:runtime` epoch 13.
 *
 * Building a runtime and starting a session on it, written the way it was
 * authored at epoch 13. It must keep compiling for as long as that epoch is
 * advertised as supported.
 *
 * ## What moved, and why epoch 13 survives it
 *
 * Nothing on this surface. Epoch 14 records a RELEASE TAG change and no
 * signature: `HostGenerateFn` — the type `RuntimeOptions.generate` is built
 * from, and which this capability's report carries as a forgotten declaration
 * because a public signature references it — lost its `@internal` tag when
 * `@alexkroman1/aai-runtime/eval` began publishing a field of that type
 * (`EvalSessionOptions.generate`). A type going from unnameable to nameable
 * adds an import path and removes none, so every caller authored here is
 * unaffected. That is what makes this a retain rather than a drop.
 *
 * The direction that WOULD break is the reverse — a public option's type going
 * back to `@internal`, so a host that had held one in a variable can no longer
 * name it. `check:api-nameable` is what now fails a change in that direction
 * before it reaches an epoch.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 13 has to be dropped with a reason.
 */

import type { AgentDef } from "@alexkroman1/aai";
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
const agent: AgentDef = {
  name: "Frozen Example",
  systemPrompt: "You are helpful.",
  greeting: "Hello.",
  maxSteps: 4,
  tools: {},
};

/**
 * ── EDIT: what this host supplies the runtime. ──────────────────────────
 *
 * `agent` is the only required member. Everything else is a seam a host fills
 * when it has something better than the default — a credential source that is
 * not `process.env`, a `runCode` executor, a bounded `fetch`. A host that fills
 * none of them still gets a working runtime, which is the property this shape
 * is for.
 */
const OPTIONS: RuntimeOptions = {
  agent,
  env: { ASSEMBLYAI_API_KEY: "not-a-real-key" },
};

/** The runtime itself. One per deployment, reused across every session. */
export function runtimeFor(options: RuntimeOptions = OPTIONS): AgentRuntime {
  return createRuntime(options);
}

/**
 * ── EDIT: how a session is started. ─────────────────────────────────────
 *
 * `startSession` is what a transport calls once it holds a socket: the options
 * carry what is true of THIS session rather than of the deployment — whether the
 * caller has already heard the greeting, and which session to resume from. It
 * returns nothing, because the socket is the handle.
 */
export function startSession(
  runtime: SessionRuntime,
  ws: Parameters<SessionRuntime["startSession"]>[0],
  options: SessionStartOptions = {},
): void {
  runtime.startSession(ws, options);
}

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
 * ── EDIT: whether this caller has already heard the greeting. ───────────
 *
 * A predicate rather than a boolean is the interesting arm: a resume decides
 * per connection, and the runtime asks at the moment it would speak rather than
 * at the moment the option was built.
 */
export const skipGreetingWhenResuming: SkipGreetingOption = () => true;

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
 * happens off-platform: the container is the security boundary and nothing here
 * pretends otherwise. A host that has its own isolate supplies this.
 */
export const refusingRunCode: RunCodeExecutor = async () => ({
  error: "run_code needs an executor this deployment does not have",
});
