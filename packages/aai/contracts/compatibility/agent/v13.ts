// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 13.
 *
 * **Moved by an ADDITIVE protocol change**, which is the cheapest kind this
 * capability sees and still worth an epoch: `SessionEvent` gained
 * `history.restored`, the frame a resume uses to send a client the conversation
 * it cannot otherwise see. `AgentDef.events` is keyed by event NAME, so the
 * union's members are part of the shape an author satisfies — a new one is a new
 * key a handler map may declare. Nothing was removed or renamed, so epoch 12 is
 * RETAINED and `./v12.ts` compiles unchanged beside this file.
 *
 * So this is epoch 12's agent with a handler for the new event, which is the one
 * thing epoch 12 could not express. Two properties of that handler are the same
 * ones every other handler here is written to respect — it is OBSERVE-ONLY, and
 * a throw in it is logged against the event rather than ending the session — plus
 * one that is specific to this frame: it is NOT in the retained event stream, so
 * a handler sees it exactly once per resume rather than on replay.
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
  // The epoch's own addition. The messages are the conversation the server
  // restored, in the order it restored them, and carry no ids — the client mints
  // those as render keys, so nothing here may depend on one.
  "history.restored": (event, ctx) =>
    void [ctx.sessionId, event.messages.length, event.messages[0]?.role],
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
