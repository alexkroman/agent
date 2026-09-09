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
import { TOOL_EXECUTION_TIMEOUT_MS } from "./constants.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { createSeededRandom } from "./random.ts";
import { createDetachedSlotStore } from "./session-state.ts";
import {
  type StubDelegate,
  type StubDelegateReply,
  type StubDelegateRoute,
  stubDelegate,
} from "./testing-delegate.ts";
import {
  type StubGenerate,
  type StubGenerateReply,
  type StubGenerateRoutes,
  stubGenerate,
} from "./testing-generate.ts";
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
  /**
   * The `ctx.generate` fake — `model.calls` is every prompt the tools sent.
   *
   * Present on every context, so an assertion needs no null check, and WIRED
   * whenever `generate` arrived as a script or as a fake. Given a bare function
   * (or nothing at all) it is a fake nothing reaches: `model.calls` stays empty
   * for the same reason {@link TestToolContext.sent} does when a test brings its
   * own `send` spy — the seam belongs to the caller, and so does the log.
   */
  readonly model: StubGenerate;
  /**
   * The `ctx.delegate` fake — `desk.calls` is every subagent run the tools asked
   * for. Present and wired on the same terms as {@link TestToolContext.model}.
   */
  readonly desk: StubDelegate;
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
 * The two MODEL seams are widened rather than mapped, because each also accepts
 * the SCRIPT its fake is built from — see their own docs below.
 *
 * @public
 */
export type ToolContextOverrides = {
  [K in Exclude<keyof ToolContext, "generate" | "delegate">]?: ToolContext[K] | undefined;
} & {
  /**
   * A real `ctx.generate`, or `stubGenerate`'s own SCRIPT — a table of routes
   * keyed by system prompt, a bare string, or one `{ text, object }` reply.
   *
   * A script is built into the fake here, so the two-step every spec wrote —
   * `stubGenerate(script)`, destructure, `createToolContext({ generate })` — is
   * one call, and the fake comes back on {@link TestToolContext.model}.
   *
   * **A FUNCTION in this position is the seam itself**, never a top-level
   * function route: `GenerateFn` and `(call) => StubGenerateReply` are both
   * `(x) => y` and nothing at runtime can tell them apart. A spec that wants a
   * computed single route builds the fake and passes both halves —
   * `createToolContext({ generate: model.generate, model })` — which is what
   * `scriptedToolContext` does.
   */
  generate?: ToolContext["generate"] | StubGenerateRoutes | StubGenerateReply | undefined;
  /**
   * A real `ctx.delegate`, or `stubDelegate`'s own SCRIPT — a table of routes
   * keyed by subagent name, or one reply. A function is the seam, on the same
   * rule as `generate` above; the fake comes back on
   * {@link TestToolContext.desk}.
   */
  delegate?:
    | ToolContext["delegate"]
    | Readonly<Record<string, StubDelegateRoute>>
    | StubDelegateReply
    | undefined;
  /**
   * A fake this spec built itself, to be exposed as {@link TestToolContext.model}
   * — and, unless `generate` also names a function, INSTALLED as the seam.
   *
   * The escape hatch under the script sugar: a caller holding a `stubGenerate`
   * it wants to share across two contexts, or one built from a top-level
   * function route, names it here rather than leaving `ctx.model` pointing at a
   * fake nothing reaches.
   */
  model?: StubGenerate | undefined;
  /** The `stubDelegate` twin of {@link ToolContextOverrides.model}. */
  desk?: StubDelegate | undefined;
};

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

/**
 * The seed behind `createToolContext`'s default `ctx.random`.
 *
 * A fixed number rather than a per-call one: two contexts built by one spec
 * draw the SAME sequence, so a test comparing two runs of a tool is comparing
 * the tool rather than the draw. A spec that wants two different sequences
 * passes `createSeededRandom(n)` itself.
 */
const TEST_RANDOM_SEED = 20_260_101;

/** Distinct session ids across a file, so two contexts are two sessions. */
let sessionCounter = 0;

/**
 * `ctx.generate` for a spec that named neither a function, a script nor a fake.
 *
 * It says which override to pass, which is the one thing a route-less fake
 * cannot: `stubGenerate({})` rejects naming the system prompt it could not
 * route, and the spec's mistake is one level up from there.
 */
const UNSTUBBED_GENERATE: ToolContext["generate"] = () =>
  Promise.reject(
    new Error("ctx.generate was not stubbed for this test — pass `generate` to createToolContext"),
  );

/** The `ctx.delegate` twin of {@link UNSTUBBED_GENERATE}. */
const UNSTUBBED_DELEGATE: ToolContext["delegate"] = () =>
  Promise.reject(
    new Error(
      "ctx.delegate was not stubbed for this test — pass `delegate` to " +
        "createToolContext (see stubDelegate)",
    ),
  );

/**
 * The `ctx.generate` to install, from what the caller named.
 *
 * Three cases in the order they win: a FUNCTION is the seam itself (see
 * {@link ToolContextOverrides.generate} for why a top-level function route
 * cannot be), a script or a caller-built `model` installs the fake, and naming
 * none of the three leaves {@link UNSTUBBED_GENERATE} in place.
 */
function generateSeam(
  override: ToolContextOverrides["generate"],
  own: StubGenerate | undefined,
  fake: StubGenerate,
): ToolContext["generate"] {
  if (typeof override === "function") return override;
  if (override === undefined && own === undefined) return UNSTUBBED_GENERATE;
  return fake.generate;
}

/** The `ctx.delegate` twin of {@link generateSeam}. */
function delegateSeam(
  override: ToolContextOverrides["delegate"],
  own: StubDelegate | undefined,
  fake: StubDelegate,
): ToolContext["delegate"] {
  if (typeof override === "function") return override;
  if (override === undefined && own === undefined) return UNSTUBBED_DELEGATE;
  return fake.delegate;
}

/**
 * Build a {@link ToolContext} for testing a tool's `execute` in isolation.
 *
 * Defaults are chosen so the context is inert: empty `env`, an empty slot store,
 * `workflows`, `generate` and `delegate` that reject with a message naming
 * themselves, a `signal` that never aborts, and a `send` that records.
 * Override any of them.
 *
 * **`generate` and `delegate` also take a SCRIPT**, which is the way in for a
 * tool that calls a model: pass `stubGenerate`'s own argument and the fake is
 * built here, installed, and handed back on `ctx.model` (`ctx.desk` for
 * `delegate`). {@link scriptedToolContext} is the same thing under a name that
 * says both seams are scripted, and returns the two fakes beside the context.
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
 * @example Scripting the model in the same call
 * ```ts
 * import { createToolContext } from "@alexkroman1/aai/testing";
 *
 * // A bare string answers every call; a table keyed by system prompt answers a
 * // tool that plays more than one model role.
 * const ctx = createToolContext({ generate: "A short summary." });
 * // … run the tool, then assert on what it asked:
 * // expect(ctx.model.calls.map((call) => call.prompt)).toEqual([…]);
 * ```
 *
 * @public
 */
export function createToolContext(overrides: ToolContextOverrides = {}): TestToolContext {
  const sent: SentEvent[] = [];
  sessionCounter += 1;
  // The two model seams come OUT of the spread below, because each may arrive as
  // a SCRIPT rather than as a function and a script must never land on the
  // context — see their docs on `ToolContextOverrides`. Everything else still
  // spreads last, so an override still wins.
  const { generate, delegate, model, desk, ...rest } = overrides;
  // Built either way, so `ctx.model`/`ctx.desk` need no null check at an
  // assertion. `{}` is a route table with no routes, which is what an unwired
  // fake is: it records nothing because nothing reaches it.
  const modelFake = model ?? stubGenerate(typeof generate === "function" ? {} : (generate ?? {}));
  const deskFake = desk ?? stubDelegate(typeof delegate === "function" ? {} : (delegate ?? {}));
  // Spread LAST so an override wins, including `send` — a test wanting
  // call-order assertions passes `vi.fn()` and reads that instead of `sent`.
  // An override whose value is `undefined` is DROPPED rather than spread —
  // `{ ...{ workflows: undefined } }` overwrites the default with `undefined`,
  // and the tool under test then dies on a `TypeError` instead of on the
  // sentence the default rejection carries. `omitUndefined` is the repo's one
  // spelling of that (guard-invariants rule 2), and taking a whole overrides
  // object through it is what lets every field accept `undefined` in the first
  // place.
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
    generate: generateSeam(generate, model, modelFake),
    // Inert for the same reason `generate` is, and NAMING `stubDelegate`: a
    // subagent run is the one collaborator a spec must never let reach a real
    // model, so the default has to fail rather than answer.
    delegate: delegateSeam(delegate, desk, deskFake),
    messages: [],
    // Never aborts: a test has no turn to cancel. Present rather than omitted
    // because it is always present at runtime, so a tool may read it.
    signal: new AbortController().signal,
    // The runtime's default deadline, from now — so a tool that budgets under
    // `ctx.deadlineAt` sees a realistic window rather than one already past,
    // and a spec that wants the tight case passes its own instant.
    deadlineAt: Date.now() + TOOL_EXECUTION_TIMEOUT_MS,
    // SEEDED, where production is `Math.random` — the one default here that is
    // deliberately not what the runtime does. A spec that never thinks about
    // randomness is then still deterministic, which is the whole reason
    // `ctx.random` exists; a spec that cares passes its own source. Seeded
    // rather than constant because a constant source is degenerate: `shuffled`
    // would return a fixed permutation and `mintCode` would re-draw one code.
    random: createSeededRandom(TEST_RANDOM_SEED),
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
    model: modelFake,
    desk: deskFake,
    ...omitUndefined(rest),
  };
}
