// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 9.
 *
 * `WorkflowClient` gained `signal`, so `createStubWorkflows`'s overrides gained
 * it too — which is why this is a real epoch here rather than a ripple: a spec
 * for a tool that answers a run's hook needs to stub exactly that method.
 *
 * It also shows the property that builder exists for. A hand-written stub is a
 * literal plus a cast, and a cast keeps compiling when the client GAINS a
 * method — leaving it `undefined` for the tool to call. This whole epoch is that
 * event, and the builder is what turned it into no work at all for callers that
 * do not drive `signal`.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { createStubWorkflows, createToolContext } from "../../../sdk/testing.ts";

/** The tool under test: it answers whatever the run is waiting to hear. */
async function answerGate(sessionId: string): Promise<boolean> {
  const ctx = createToolContext({
    sessionId,
    // Only the method this spec drives. Every other one rejects by NAME rather
    // than resolving `undefined`, so a tool reaching past what the test set up
    // says so instead of failing three lines later on a missing field.
    workflows: createStubWorkflows({ signal: async () => true }),
  });
  return await ctx.workflows.signal(`approval:${ctx.sessionId}`, { keep: true });
}

/** The other half of the contract: a token nobody holds answers `false`. */
async function gateAlreadySettled(): Promise<boolean> {
  const ctx = createToolContext({ workflows: createStubWorkflows({ signal: async () => false }) });
  return await ctx.workflows.signal("approval:none");
}

export async function exerciseStubs(): Promise<[boolean, boolean]> {
  return [await answerGate("s_1"), await gateAlreadySettled()];
}
