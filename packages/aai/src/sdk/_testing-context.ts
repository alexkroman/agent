// Copyright 2026 the AAI authors. MIT license.
/**
 * The {@link ToolContext} a spec builds to drive one tool.
 *
 * Split out of `sdk/testing.ts` rather than living in it, and the reason is a
 * CYCLE rather than length: `runTool` (`sdk/testing-tools.ts`) defaults its
 * context to a fresh one, and `sdk/testing.ts` re-exports `runTool` — so the
 * builder living in the assembly point would make the assembly point import
 * itself. Everything here is re-exported from `sdk/testing.ts`; nothing outside
 * this package imports this module by name.
 *
 * @module _testing-context
 */

import { clientEventDropMessage, decideClientEvent } from "./client-event.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { createDetachedSlotStore } from "./session-state.ts";
import type { ToolContext } from "./types.ts";
import type { WorkflowClient } from "./workflow.ts";
import { rejectingWorkflows } from "./workflow-unavailable.ts";

/**
 * One `ctx.send(event, data)` call that would REACH the client, as recorded by
 * {@link createToolContext} — see the `send` default for what is left out.
 */
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
export type TestToolContext = ToolContext & {
  /**
   * Events `ctx.send` would put on the wire, in call order. An event the
   * runtime would drop (over the payload cap, an over-long name, no JSON form)
   * is not here, for the same reason it is not in the browser.
   */
  readonly sent: SentEvent[];
};

/**
 * What {@link createToolContext} accepts: any field of a {@link ToolContext},
 * and `undefined` for one the caller does not have.
 *
 * **Not `Partial<ToolContext>`, and the difference is the whole point.** Under
 * `exactOptionalPropertyTypes` — which this repo and the scaffold both set —
 * `Partial<T>` means `sessionId?: string`, a property that may be ABSENT but
 * whose value may never be `undefined`. So a spec holding a `string |
 * undefined` could not pass it, and the workaround it reached for instead was a
 * conditional spread:
 *
 * ```ts no-check
 * createToolContext({ generate, ...(sessionId ? { sessionId } : {}) });
 * ```
 *
 * Two shipped templates had that line byte-identical, and it is the exact shape
 * this repo's own `guard-invariants` rule 22 counts as debt — so the SDK's
 * signature was teaching the pattern its gates refuse. Adding `| undefined` to
 * every field costs nothing (an explicit `undefined` and an absent key
 * both fall through to the default, because {@link createToolContext} takes the
 * overrides through `omitUndefined` before spreading them) and strictly widens what compiles.
 *
 * @public
 */
export type ToolContextOverrides = { [K in keyof ToolContext]?: ToolContext[K] | undefined };

/**
 * A `ctx.workflows` for testing a tool that starts or reads durable runs: every
 * method rejects by default, and `overrides` replaces the ones the test drives.
 *
 * **The alternative is a cast, and the cast is what goes wrong.** A complete
 * `WorkflowClient` is eight methods, of which a tool's test usually drives one or
 * two, so the hand-rolled version is a literal with `as WorkflowClient` — which
 * keeps compiling when the client GAINS a method and leaves that method
 * `undefined`. Two shipped templates had exactly that, and adding `wakeUp` and
 * `stream` to the client is what surfaced it: the casts still compiled.
 *
 * Rejecting rather than no-op defaults, for the reason `createUnusedDb` rejected
 * before it went away with `ctx.db` — a tool that reaches for a method the test
 * did not stub should say so, not silently receive `undefined`. `listing` is the exception and returns `[]`,
 * because it is synchronous and an empty list is a truthful answer.
 *
 * ```ts
 * import { createStubWorkflows, createToolContext } from "@alexkroman1/aai/testing";
 *
 * const workflows = createStubWorkflows({ start: async () => "wrun_1" });
 * const ctx = createToolContext({ workflows });
 * ```
 *
 * @public
 */
export function createStubWorkflows(overrides: Partial<WorkflowClient> = {}): WorkflowClient {
  return {
    ...rejectingWorkflows(
      "This ctx.workflows method was not stubbed for this test — pass it in the " +
        "overrides handed to createStubWorkflows",
    ),
    ...overrides,
  };
}

/** Distinct session ids across a file, so two contexts are two sessions. */
let sessionCounter = 0;

/**
 * Build a {@link ToolContext} for testing a tool's `execute` in isolation.
 *
 * Defaults are chosen so the context is inert: empty `env`, an empty slot store,
 * a `db`, `generate` and `delegate` that reject with a message naming
 * themselves, a `signal` that never aborts, and a `send` that records.
 * Override any of them.
 *
 * **Each call is a distinct session.** `sessionId` auto-increments, which is
 * what makes the two-context isolation test — the same tool run against two
 * contexts must not share state — read the way it does. Pass `sessionId`
 * explicitly when a test needs two contexts to be the SAME session (a
 * reconnect, a keyed lock).
 *
 * **An override may be `undefined`**, which means "I do not have one" and
 * leaves the default in place — see {@link ToolContextOverrides} for why that
 * is not `Partial<ToolContext>`.
 *
 * There is no state type parameter, because there is no `ctx.state` bag to
 * type: a slot types its own value in the module that declares it, and reading
 * the slot back is how a spec asserts what a tool wrote.
 *
 * @example
 * ```ts no-check
 * // `no-check`: the tool under test is in another file, which is the point.
 * import { createToolContext } from "@alexkroman1/aai/testing";
 * import { expect, test } from "vitest";
 * import { cartSlot } from "./shared.ts";
 * import addItem from "./tools/add_item.ts";
 *
 * test("add_item appends to this session's cart", async () => {
 *   const ctx = createToolContext();
 *   await addItem.execute({ item: "apple" }, ctx);
 *   expect(cartSlot.get(ctx).items).toEqual(["apple"]);
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
export function createToolContext(overrides: ToolContextOverrides = {}): TestToolContext {
  const sent: SentEvent[] = [];
  sessionCounter += 1;
  // Spread LAST so an override wins, including `send` — a test wanting
  // call-order assertions passes `vi.fn()` and reads that instead of `sent`.
  // An override whose value is `undefined` is DROPPED rather than spread —
  // `{ ...{ db: undefined } }` overwrites the default with `undefined`, and the
  // tool under test then dies on a `TypeError` instead of on the sentence the
  // default rejection carries. `omitUndefined` is the repo's one spelling of
  // that (guard-invariants rule 2), and taking a whole overrides object through
  // it is what lets every field accept `undefined` in the first place.
  return {
    sessionId: `test-session-${sessionCounter}`,
    env: {},
    // A real slot store, empty, and NOT a stub: it applies the same
    // storability check and the same freeze the deployed one does, so a
    // template holding a `Map` in a slot fails in its own spec rather than on
    // the first deployment that has a database. Each call is a distinct
    // session, so two contexts never share slot values.
    slots: createDetachedSlotStore(),
    // Inert like `generate`: a tool that starts a workflow is testing
    // that it starts one, so the default names itself in the rejection and a
    // spec asserting the call passes its own stub.
    workflows: rejectingWorkflows(
      "ctx.workflows was not provided to createToolContext(). Pass `workflows` to " +
        "assert what your tool starts.",
    ),
    generate: () =>
      Promise.reject(
        new Error(
          "ctx.generate was not stubbed for this test — pass `generate` to createToolContext",
        ),
      ),
    // Inert for the same reason `generate` is, and NAMING `stubDelegate`: a
    // subagent run is the one collaborator a spec must never let reach a real
    // model, so the default has to fail rather than answer.
    delegate: () =>
      Promise.reject(
        new Error(
          "ctx.delegate was not stubbed for this test — pass `delegate` to " +
            "createToolContext (see stubDelegate)",
        ),
      ),
    messages: [],
    // Never aborts: a test has no turn to cancel. Present rather than omitted
    // because it is always present at runtime, so a tool may read it.
    signal: new AbortController().signal,
    /**
     * Records what the client would RECEIVE, which is not everything a tool
     * sends: `decideClientEvent` is the runtime's own rule, so an event over
     * the 64 KB payload cap, one whose name is too long, and one that has no
     * JSON form are all absent from `sent` here exactly as they are absent
     * from the wire. A double that recorded them let a spec assert a
     * notification production silently threw away — the same failure the
     * `stubStepFetch`-over-`vi.stubGlobal` rule exists to prevent, one layer
     * up. The drop is announced rather than silent, because a spec author
     * looking at an empty `sent` deserves the reason.
     */
    send: (event: string, data: unknown) => {
      const decision = decideClientEvent(event, data);
      if ("drop" in decision) {
        console.warn(`${clientEventDropMessage(event, decision.drop)} (createToolContext)`);
        return;
      }
      sent.push({ event, data });
    },
    sent,
    ...omitUndefined(overrides),
  };
}
