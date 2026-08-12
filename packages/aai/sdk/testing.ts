// Copyright 2026 the AAI authors. MIT license.
/**
 * Test helpers for agent code (the `@alexkroman1/aai/testing` subpath).
 *
 * A tool's `execute` takes a {@link ToolContext}, so testing one means building
 * one. Every field is supplied at runtime and most tests care about exactly
 * two of them (`state`, `sessionId`), which is why the hand-rolled version of
 * this ends up as `{ … } as unknown as ToolContext` — a cast that also stops
 * telling you when a field is added.
 *
 * Framework-agnostic on purpose: `send` records into an array rather than
 * calling a mock library, so this module carries no test-runner dependency and
 * a spy can still be passed in when a test wants call-order assertions.
 *
 * @module testing
 */

import type { Db } from "./db.ts";
import type { DefaultSessionState, ToolContext } from "./types.ts";
import { rejectingWorkflows } from "./workflow.ts";

/** One `ctx.send(event, data)` call, as recorded by {@link createToolContext}. */
export interface SentEvent {
  event: string;
  data: unknown;
}

/**
 * A {@link ToolContext} that records what its tools sent.
 *
 * Assignable to `ToolContext` wherever one is required, so it passes straight
 * to `execute`.
 *
 * @public
 */
export type TestToolContext<S = DefaultSessionState> = ToolContext<S> & {
  /** Events `ctx.send` received, in call order. */
  readonly sent: SentEvent[];
};

/**
 * A `Db` whose every query rejects, naming the field — the default for a test
 * context, so a tool that unexpectedly reaches for storage fails with that
 * sentence instead of a `TypeError` on `undefined`.
 *
 * @public
 */
export function createUnusedDb(): Db {
  return {
    query: () =>
      Promise.reject(
        new Error("ctx.db was not stubbed for this test — pass `db` to createToolContext"),
      ),
  };
}

/** Distinct session ids across a file, so two contexts are two sessions. */
let sessionCounter = 0;

/**
 * Build a {@link ToolContext} for testing a tool's `execute` in isolation.
 *
 * Defaults are chosen so the context is inert: empty `env`, empty `state`, a
 * `db` and `generate` that reject with a message naming themselves, a `signal`
 * that never aborts, and a `send` that records. Override any of them.
 *
 * **Each call is a distinct session.** `sessionId` auto-increments, which is
 * what makes the two-context isolation test — the same tool run against two
 * contexts must not share state — read the way it does. Pass `sessionId`
 * explicitly when a test needs two contexts to be the SAME session (a
 * reconnect, a keyed lock).
 *
 * @typeParam S - The session-state shape, so `ctx.state` is typed in the test
 *   the same way the agent types it. Pass `state` to infer it.
 *
 * @example
 * ```ts no-check
 * // `no-check`: the tool under test is in another file, which is the point.
 * import { createToolContext } from "@alexkroman1/aai/testing";
 * import { expect, test } from "vitest";
 * import { addItem } from "./tools/add_item.ts";
 *
 * test("add_item appends to this session's cart", async () => {
 *   const ctx = createToolContext();
 *   await addItem.execute({ item: "apple" }, ctx);
 *   expect(ctx.state).toEqual({ cart: { items: ["apple"] } });
 * });
 * ```
 *
 * @example Asserting on what a tool sent
 * ```ts no-check
 * import { createToolContext } from "@alexkroman1/aai/testing";
 * import { expect, test } from "vitest";
 * import { recommend } from "./tools/recommend.ts";
 *
 * test("recommend pushes its picks to the client", async () => {
 *   const ctx = createToolContext();
 *   await recommend.execute({ mood: "chill" }, ctx);
 *   expect(ctx.sent).toEqual([{ event: "recommendations", data: expect.anything() }]);
 * });
 * ```
 *
 * @public
 */
export function createToolContext<S = DefaultSessionState>(
  overrides: Partial<ToolContext<S>> = {},
): TestToolContext<S> {
  const sent: SentEvent[] = [];
  sessionCounter += 1;
  // Spread LAST so an override wins, including `send` — a test wanting
  // call-order assertions passes `vi.fn()` and reads that instead of `sent`.
  return {
    sessionId: `test-session-${sessionCounter}`,
    env: {},
    // The empty bag a slot-backed agent starts from — the same thing the
    // runtime hands a session with no `state` factory, which is why it is the
    // default. The cast is unavoidable: `S` is unconstrained, so nothing proves
    // `{}` inhabits it. It is confined to this one line rather than pushed onto
    // every caller, which is the point of the helper; a caller who cares passes
    // `state` and overrides it below.
    state: {} as S,
    // Inert like `db` and `generate`: a tool that starts a workflow is testing
    // that it starts one, so the default names itself in the rejection and a
    // spec asserting the call passes its own stub.
    workflows: rejectingWorkflows(
      "ctx.workflows was not provided to createToolContext(). Pass `workflows` to " +
        "assert what your tool starts.",
    ),
    db: createUnusedDb(),
    generate: () =>
      Promise.reject(
        new Error(
          "ctx.generate was not stubbed for this test — pass `generate` to createToolContext",
        ),
      ),
    messages: [],
    // Never aborts: a test has no turn to cancel. Present rather than omitted
    // because it is always present at runtime, so a tool may read it.
    signal: new AbortController().signal,
    send: (event: string, data: unknown) => {
      sent.push({ event, data });
    },
    sent,
    ...overrides,
  };
}
