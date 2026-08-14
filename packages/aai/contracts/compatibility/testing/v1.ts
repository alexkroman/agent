// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `testing` epoch 1.
 *
 * This is the capability a USER'S OWN PROJECT imports to unit-test a tool, so
 * a break here breaks their test suite rather than their agent — which is the
 * kind of break that is easiest to ship unnoticed.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import {
  createToolContext,
  createUnusedDb,
  type SentEvent,
  type TestToolContext,
} from "../../../sdk/testing.ts";

type CartState = { items: string[] };

/** The default context: inert everything, and a recording `send`. */
export async function exerciseDefaults(): Promise<SentEvent[]> {
  const ctx: TestToolContext = createToolContext();
  ctx.send("cart_updated", { items: 1 });
  return ctx.sent;
}

/** Overriding the pieces a tool under test actually reads. */
export async function exerciseOverrides(): Promise<string> {
  const ctx = createToolContext<CartState>({
    env: { ASSEMBLYAI_API_KEY: "test-key" },
    state: { items: ["widget"] },
    messages: [{ role: "user", content: "add a widget" }],
    sessionId: "session-1",
    db: createUnusedDb(),
  });
  const first: string | undefined = ctx.state.items[0];
  return `${ctx.sessionId}:${first ?? "none"}`;
}

/** Two calls are two SESSIONS unless the id is pinned. */
export function distinctSessions(): boolean {
  const first = createToolContext();
  const second = createToolContext();
  return first.sessionId !== second.sessionId;
}

export function sharedSession(sessionId: string): boolean {
  const first = createToolContext({ sessionId });
  const second = createToolContext({ sessionId });
  return first.sessionId === second.sessionId;
}
