// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 14.
 *
 * **Moved for a TRANSITIVE reason, as epoch 13 did** — and the two are worth
 * telling apart, because this one lands on a helper whose whole job is to keep up
 * with the type. Nothing on `/testing` was added, removed or renamed; the export
 * list is identical to epoch 13's. What changed is `WorkflowClient`, which gained
 * `publicWebhookUrl`, and `createStubWorkflows` returns one. Epoch 13 is RETAINED
 * and `./v13.ts` compiles unchanged beside this file.
 *
 * What is new is the behaviour that made the addition non-trivial for a spec:
 * `createStubWorkflows` fills every unstubbed method with a rejector, and
 * `publicWebhookUrl` is SYNCHRONOUS — so it THROWS rather than rejecting, and a
 * test that means to exercise a tool which mints a URL has to pass one in. That
 * asymmetry (`listing` answers `[]`, this throws) is the point: there is no
 * truthful empty answer for a URL.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { tool } from "../../../index.ts";
import { createStubWorkflows, createToolContext } from "../../../sdk/testing.ts";

const callbackUrl = tool({
  description: "Where the provider should confirm this checkout.",
  execute: (_args, ctx) => ({
    url: ctx.workflows.publicWebhookUrl(`checkout:${ctx.sessionId}`),
  }),
});

/** A stub that answers the one method the tool under test reaches. */
export function mintsAPublicCallbackUrl(): unknown {
  const ctx = createToolContext({
    workflows: createStubWorkflows({
      publicWebhookUrl: (token) => `https://aai.example/desk/.well-known/webhook/${token}`,
    }),
  });
  return callbackUrl.execute({}, ctx);
}

/**
 * The unstubbed case, which is what a spec asserts when the SUBJECT is the tool
 * failing loudly on an unconfigured deployment: it throws rather than rejecting,
 * so the assertion is `expect(fn).toThrow()` and never `.rejects`.
 */
export function throwsWhenNotStubbed(): boolean {
  const ctx = createToolContext({ workflows: createStubWorkflows() });
  try {
    void callbackUrl.execute({}, ctx);
    return false;
  } catch {
    return true;
  }
}
