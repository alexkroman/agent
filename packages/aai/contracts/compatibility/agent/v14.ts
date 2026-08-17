// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 14.
 *
 * **Moved by the SAME frame widening, one commit later**, which is worth keeping as
 * its own epoch rather than folding into 13: `history.restored` gained
 * `toolCalls`, so a handler can now see the tool rows interleaved through a
 * restored conversation and not just its dialogue. Epoch 13 is RETAINED and
 * `./v13.ts` compiles unchanged beside this file — which is the point of the pair,
 * since 13's handler reads only `messages` and still type-checks.
 *
 * So this is epoch 13's agent whose handler reads BOTH halves. The properties it
 * respects are the ones every handler here does — OBSERVE-ONLY, a throw logged
 * rather than fatal — plus two specific to this frame: it is not in the retained
 * event stream (a handler sees it once per resume, never on replay), and a tool
 * call's anchor is an INDEX into the same frame's `messages`, because the client
 * mints the render keys.
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
  // The epoch's own addition: the tool half, anchored into the message half.
  // Neither carries ids — the client mints those as render keys — so an anchor is
  // an index, and `-1` means "before any message".
  "history.restored": (event, ctx) =>
    void [
      ctx.sessionId,
      event.messages.length,
      event.toolCalls.map((call) => [call.name, call.status, call.afterMessageIndex]),
    ],
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
