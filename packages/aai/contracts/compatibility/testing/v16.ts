// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 16.
 *
 * **Moved for a TRANSITIVE reason, as epochs 13, 14 and 15 did**, and by the same
 * frame widening that moved `aai:agent` to 14: `history.restored` gained
 * `toolCalls`. Nothing on `/testing` was added, removed or renamed — the
 * export list is identical to epoch 15's — but `createToolContext`'s `ctx.sent`
 * records what a tool emitted in that union's own vocabulary, so a member added
 * to it is part of the shape a spec reads back. Epoch 14 is RETAINED and
 * `./v14.ts` compiles unchanged beside this file.
 *
 * So this keeps epoch 14's example verbatim and adds the assertion the new frame
 * makes possible: that a tool's `ctx.send` is recorded, and that reading it back
 * is a TYPED narrowing rather than a cast. That is the property worth freezing —
 * `ctx.sent` is why `createToolContext`'s `send` is a recorder and not a no-op.
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

const announces = tool({
  description: "Tell the client something the model decided.",
  execute: (_args, ctx) => {
    ctx.send("cart_updated", { items: 2 });
    return { ok: true };
  },
});

/**
 * What a spec reads back off `ctx.sent` — the epoch's own addition.
 *
 * The recorder is the reason `createToolContext`'s defaults are inert but not
 * absent: a `send` that did nothing would make this assertion impossible, and a
 * tool whose whole contract is "it tells the client" would be untestable without
 * a hand-rolled fake per spec.
 */
export function recordsWhatItSent(): { event: string; data: unknown } | undefined {
  const ctx = createToolContext();
  void announces.execute({}, ctx);
  return ctx.sent[0];
}
