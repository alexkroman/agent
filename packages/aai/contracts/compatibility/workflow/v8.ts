// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `workflow` epoch 8.
 *
 * Epoch 8 adds `WorkflowClient.publicWebhookUrl(token)` — the URL a THIRD PARTY
 * delivers a callback to. It exists because the DevKit's own `hook.url` cannot
 * be that: `createWebhook()` composes it from `getWorkflowMetadata().url`, which
 * is `http://localhost:<port>` off the running process, so a deployed agent hands
 * a payment provider the inside of a container that has self-exited by the time
 * the callback comes. This one is built from the agent's configured `publicUrl`
 * plus the same route constant the guest's own router parses.
 *
 * Epochs 1 through 7 are unchanged and RETAINED — the method is an addition, and
 * `./v7.ts` compiles unchanged beside this file — so this demonstrates only what
 * is new.
 *
 * Two rules it is written to respect, both of which the type cannot state:
 *
 * - **The token is the CALLER's**, derived in one exported helper the body and
 *   the tool both import, exactly as `signal` (epoch 7) takes it. That is also
 *   why the pair below is `createHook({ token })` rather than `createWebhook()`,
 *   whose token is random and body-side only: a URL that has to be minted from a
 *   TOOL needs a token the tool can compute.
 * - **Unconfigured THROWS**, and a tool should not paper over it. There is
 *   nothing a caller can say that configures a deployment, so this is not a
 *   {@link ToolFailure} to hand the model — it is a `publicUrl` somebody has to
 *   set, and the message names it.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { tool, workflow } from "../../../index.ts";

export const settle = workflow({
  description: "Take the payment, then wait for the provider to confirm it.",
  input: z.object({ invoice: z.string(), payer: z.string() }),
  async run(input) {
    await Promise.resolve();
    return { invoice: input.invoice, confirmed: true };
  },
});

/**
 * The token, derived in ONE place — the same rule epoch 7's `signal` example
 * states, and it binds harder here: this string is half of a URL a stranger will
 * POST to, so the body's hook and the tool's URL must agree on it exactly.
 */
export function settlementToken(invoice: string): string {
  return `settlement:${invoice}`;
}

export const payment_callback_url = tool({
  description: "Tell the payment provider where to confirm this invoice.",
  inputSchema: z.object({ invoice: z.string() }),
  execute(args, ctx) {
    // Synchronous, and it THROWS when the deployment never told the SDK its own
    // public URL. Deliberately not caught: `hook.url` would be the "graceful"
    // alternative and it is a localhost URL, i.e. the same failure days later
    // and on somebody else's server.
    const url: string = ctx.workflows.publicWebhookUrl(settlementToken(args.invoice));
    return { url };
  },
});
