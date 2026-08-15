// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 12.
 *
 * **Moved for a TRANSITIVE reason.** Nothing on this capability's own surface was
 * added, removed or renamed — the export list is identical to epoch 11's. What
 * changed is `WorkflowClient`, which gained `publicWebhookUrl`; `AgentDef` names
 * `workflows`, and a `ToolContext` reaches the client as `ctx.workflows`. A
 * capability's hash covers the shape a consumer has to satisfy, so a type
 * reachable FROM the surface is part of it — the same reason
 * `includeForgottenExports` is on. Epoch 11 is RETAINED and `./v11.ts` compiles
 * unchanged beside this file.
 *
 * So this is epoch 11's agent — `events` plus a slot projection — declaring the
 * `workflows` record as well, which is the field the moved type hangs off. The
 * two rules that combination is written to respect: a handler is OBSERVE-ONLY and
 * a throw in one is non-fatal, and a workflow is named by the KEY it is declared
 * under (which is what `ctx.workflows.start(def, …)` resolves by identity).
 *
 * See `./v3.ts` for what "frozen" obliges and why the imports are relative.
 */

import { z } from "zod";

import type { SessionEventHandlers } from "../../../index.ts";
import { agent, sessionSlot, workflow } from "../../../index.ts";

const auditSlot = sessionSlot("audit", () => ({ seen: [] as string[] }));

const handlers: SessionEventHandlers = {
  // `meta.id` is the de-duplication key: delivery is at-least-once.
  "tool.called": (event, ctx) => void [ctx.sessionId, event.meta.id, event.toolName],
  // Async and throwing are both legal: neither is awaited, and a throw is logged
  // against the event rather than ending the session.
  "session.configured": async (event) => {
    await Promise.resolve();
    if (event.sampleRate === 0) throw new Error("logged, not fatal");
  },
};

export const settle = workflow({
  description: "Take the payment, then wait for the provider to confirm it.",
  input: z.object({ invoice: z.string() }),
  async run(input) {
    await Promise.resolve();
    return { invoice: input.invoice, confirmed: true };
  },
});

export default agent({
  name: "Observed",
  greeting: "What can I get you?",
  events: handlers,
  // The KEY is the name — `settle` — and it is what a tool passing the def
  // resolves to by identity, so a rename here is one edit rather than two.
  workflows: { settle },
  syncState: auditSlot.projection((audit) => ({ count: audit.seen.length })),
});
