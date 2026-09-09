// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring template: `aai-runtime:runtime` epoch 2.
 *
 * OPERATING a runtime once it exists — the four members a long-lived process
 * reads off it, and the shutdown that ends them — written the way a host
 * authored it at epoch 2. `v1.ts` is the other half, building one and starting
 * a session on it; this deliberately does not repeat that, because a capability
 * with two retained epochs is allowed to split its surface between them and
 * coverage is measured over the union (`api-contracts-gate.test.ts`). It must
 * keep compiling for as long as epoch 2 is advertised as supported.
 *
 * ## What moved, and why epoch 2 survives it
 *
 * A TAG, with no declaration behind it. `StepUsage` — the parameter of the
 * `onUsage` this epoch added to `HostGenerateFn`'s call-options bag — was
 * `@internal` and exported by no subpath, which `pnpm check:api-nameable` and
 * `pnpm docs:md` both objected to: a consumer could receive one and not write
 * its type. Epoch 3 retags it `@public` and publishes it from
 * `@alexkroman1/aai-runtime/eval`, beside the `HostGenerateFn` that names it.
 *
 * Nothing on THIS capability's export list changed, and the type is still not
 * importable from `@alexkroman1/aai-runtime`: it is a forgotten declaration in
 * this rollup either way, so what re-rendered is the `// @internal` above it.
 * The widening happened one subpath over, which is precisely why a host here
 * cannot notice it — and why this is a retain rather than a drop. The
 * `generate` below is written the way an epoch-2 host had to write one: it
 * REPORTS usage as an object literal and names no type at all.
 *
 * The direction that WOULD break is `onUsage` demanding something an
 * equivalent literal no longer satisfies — a required field, a brand — or
 * `AgentRuntime` losing one of the four members read below. Note which way
 * each flows: a host RECEIVES an `AgentRuntime`, so a member added to it is
 * safe and a member removed is not.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 2 has to be dropped with a reason.
 *
 * @module
 */

import { agent } from "@alexkroman1/aai";
import {
  type AgentRuntime,
  createRuntime,
  type RuntimeOptions,
  type SessionRuntime,
} from "../../../runtime-barrel.ts";

/**
 * The agent this runtime runs.
 *
 * EDIT THIS. Everything below is wiring; this is the agent.
 */
const desk = agent({
  name: "Support Desk",
  systemPrompt: "Answer from what the tools return, not from memory.",
  greeting: "Support desk.",
  maxSteps: 4,
});

/**
 * ── EDIT: what this host supplies the runtime. ──────────────────────────
 *
 * `generate` is the seam a deployment fills when it meters or routes what tool
 * code spends through `ctx.generate`. An epoch-2 host wrote its usage report as
 * a LITERAL, because the record's type was reachable from no subpath it
 * imports — that is the shape frozen here, and it must keep compiling now that
 * the type has a name somewhere else.
 */
const OPTIONS: RuntimeOptions = {
  agent: desk,
  env: { ASSEMBLYAI_API_KEY: "not-a-real-key" },
  generate: async (options, callOptions) => {
    const text = `answer for: ${options.prompt}`;
    callOptions?.onUsage?.({ inputTokens: options.prompt.length, totalTokens: text.length });
    return { text };
  },
};

/** The runtime this process operates. One per deployment. */
export const runtime: AgentRuntime = createRuntime(OPTIONS);

/**
 * ── EDIT: what a `/client-config` route answers. ────────────────────────
 *
 * `readyConfig` is what the browser needs before it may open a socket, derived
 * from the agent rather than restated by the host — which is the whole reason
 * it is on the runtime and not a second thing to keep in step.
 */
export function clientConfig(): AgentRuntime["readyConfig"] {
  return runtime.readyConfig;
}

/**
 * ── EDIT: how a queue hands a durable run back. ─────────────────────────
 *
 * Both members are OPTIONAL, and a host has to treat them that way: a
 * deployment that declares no workflows has neither, so the honest shape is a
 * guard rather than a `!`. `deliverWorkflow` is what a queue calls per
 * delivery; `workflows` is the client the same runtime hands tool code.
 */
export async function deliver(runId: string): Promise<unknown> {
  if (runtime.deliverWorkflow === undefined) throw new Error("no workflows on this deployment");
  return await runtime.deliverWorkflow(runId);
}

export function hasWorkflows(): boolean {
  return runtime.workflows !== undefined;
}

/**
 * ── EDIT: reading a session's own event log. ────────────────────────────
 *
 * `sessionEvents` is the audit seam — the same typed stream an eval reads,
 * available to the host that owns the process. `durable` is the question worth
 * asking before promising anyone a transcript survives a restart.
 */
export async function transcript(sessionId: string): Promise<{
  readonly durable: boolean;
  readonly length: number;
}> {
  const events = runtime.sessionEvents;
  if (events === undefined) return { durable: false, length: 0 };
  await events.flush(sessionId);
  return { durable: events.durable, length: events.tail(sessionId) };
}

/**
 * ── EDIT: the shutdown. ─────────────────────────────────────────────────
 *
 * Narrowed to {@link SessionRuntime} on the way in, because a shutdown handler
 * has no business with anything else on the runtime — and because that is the
 * type a host that took someone else's runtime is holding.
 */
export async function stop(target: SessionRuntime = runtime): Promise<void> {
  await target.shutdown();
}
