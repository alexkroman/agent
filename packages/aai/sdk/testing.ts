// Copyright 2026 the AAI authors. MIT license.
/**
 * Test helpers for agent code (the `@alexkroman1/aai/testing` subpath).
 *
 * A tool's `run` takes a {@link ToolContext}, so testing one means building
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
import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import { toolRun } from "./tool-fields.ts";
import type { DefaultSessionState, ToolContext, ToolDef } from "./types.ts";
import { findUnjournalable, rejectingWorkflows, type WorkflowContext } from "./workflow.ts";

/**
 * Call a tool's handler with validated-shaped args and a context.
 *
 * `ToolDef.run` is OPTIONAL — `execute` is the other legal spelling for one more
 * major — so `myTool.run(args, ctx)` does not compile for a def read out of an
 * agent's `tools` record, and a test would otherwise reach for a non-null
 * assertion at every call. This resolves whichever spelling the def carries and
 * throws naming the tool when it carries neither.
 *
 * A def that came straight from `tool()` needs none of this: that returns a
 * `DefinedTool`, whose `run` is not optional, so `myTool.run(args, ctx)` is the
 * shorter thing to write and the one the templates use.
 *
 * @public
 */
export async function runTool<P extends ToolInputSchema, S>(
  def: ToolDef<P, S> | undefined,
  args: InferSchemaOutput<P>,
  ctx: ToolContext<S>,
): Promise<unknown> {
  const run = def && toolRun(def);
  if (!(def && run)) {
    throw new Error(
      `runTool: ${def ? `"${def.description}" has no run function` : "no such tool"}`,
    );
  }
  return await run(args, ctx);
}

/** One `ctx.send(event, data)` call, as recorded by {@link createToolContext}. */
export interface SentEvent {
  event: string;
  data: unknown;
}

/**
 * A {@link ToolContext} that records what its tools sent.
 *
 * Assignable to `ToolContext` wherever one is required, so it passes straight
 * to `run`.
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
 * Build a {@link ToolContext} for testing a tool's `run` in isolation.
 *
 * Defaults are chosen so the context is inert: empty `env`, empty `state`,
 * `db`/`generate`/`workflows` that reject with a message naming themselves, a
 * `signal` that never aborts, and a `send` that records. Override any of them.
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
 *   await addItem.run({ item: "apple" }, ctx);
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
 *   await recommend.run({ mood: "chill" }, ctx);
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
    db: createUnusedDb(),
    generate: () =>
      Promise.reject(
        new Error(
          "ctx.generate was not stubbed for this test — pass `generate` to createToolContext",
        ),
      ),
    // Rejects for the same reason `db` and `generate` do, and it is the field
    // most worth defaulting: a tool that starts a workflow is testable without
    // the test knowing anything about the engine, and one that starts a
    // workflow it should not fails by name.
    workflows: rejectingWorkflows(
      "ctx.workflows was not stubbed for this test — pass `workflows` to createToolContext",
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

/**
 * A {@link WorkflowContext} that records the steps a run took.
 *
 * @public
 */
export type TestWorkflowContext = WorkflowContext & {
  /** Step names `ctx.step` received, in call order. */
  readonly steps: string[];
  /** Sleep durations `ctx.sleep` was asked for, in call order. */
  readonly sleeps: number[];
  /** Inputs `ctx.continueAs` was called with — at most one, since it unwinds. */
  readonly continuations: unknown[];
  /**
   * Waitpoint names `ctx.waitFor` reached, in call order.
   *
   * The default `waitFor` THROWS, like `continueAs`, because there is no honest
   * way to resolve one in a unit test: a waitpoint is released and woken by an
   * HTTP call, so a stub that returned a value would test a run body that never
   * waits. Pass `waitFor` to script the answers a spec wants.
   */
  readonly waits: string[];
};

/**
 * Build a {@link WorkflowContext} for testing a workflow's `run` in isolation.
 *
 * The twin of {@link createToolContext}, and it exists for the same reason —
 * hand-rolling one means a cast that stops reporting when a field is added — but
 * what it defaults is different, because a workflow's context is mostly the
 * durability machinery:
 *
 * - **`step` RUNS its function and records the name.** That is the honest
 *   default for a unit test: it exercises the body once, in order, which is what
 *   the FIRST execution of a run does. Replay, per-step retry and lease recovery
 *   are the engine's semantics, not the workflow's, and they are covered in
 *   `host/workflow-engine.test.ts` — a template test asserting on them would be
 *   testing the SDK through a template.
 * - **`sleep` records and returns immediately**, so a test does not wait out a
 *   poll interval (and does not have to install fake timers to avoid it).
 * - **`blob` resolves undefined by default**, so a run that expects an upload
 *   fails by name rather than transcribing nothing; pass `blob` to supply bytes.
 * - `db`, `generate` reject exactly as they do for a tool context.
 *
 * @example
 * ```ts no-check
 * import { createWorkflowContext } from "@alexkroman1/aai/testing";
 * import { expect, test } from "vitest";
 * import agentDef from "./agent.ts";
 *
 * test("transcribe visits every chunk", async () => {
 *   const ctx = createWorkflowContext({
 *     blob: () => Promise.resolve({ contentType: "audio/pcm", bytes: new Uint8Array(320) }),
 *   });
 *   await agentDef.workflows.transcribe.run({ blobIds: ["a", "b"] }, ctx);
 *   expect(ctx.steps).toEqual(["chunk", "chunk", "save"]);
 * });
 * ```
 *
 * @public
 */
export function createWorkflowContext(
  overrides: Partial<WorkflowContext> = {},
): TestWorkflowContext {
  const steps: string[] = [];
  const sleeps: number[] = [];
  const continuations: unknown[] = [];
  const waits: string[] = [];
  sessionCounter += 1;
  return {
    runId: `test-run-${sessionCounter}`,
    env: {},
    db: createUnusedDb(),
    generate: () =>
      Promise.reject(
        new Error(
          "ctx.generate was not stubbed for this test — pass `generate` to createWorkflowContext",
        ),
      ),
    signal: new AbortController().signal,
    step: async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
      steps.push(name);
      const output = await fn();
      // The same check the engine runs before journaling, so a step returning a
      // `Date` or a `Map` fails in the author's own `pnpm test` rather than on a
      // resume in production. It is the one piece of engine behaviour worth
      // reproducing here, because it is the one a unit test can see.
      const unjournalable = findUnjournalable(output);
      if (unjournalable !== undefined) {
        throw new Error(
          `workflow step "${name}" returned ${unjournalable}, which the run journal cannot ` +
            "store: step outputs are written as JSON and read back on the next replay.",
        );
      }
      return output;
    },
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    blob: () => Promise.resolve(undefined),
    releaseBlob: () => Promise.resolve(true),
    continueAs: (input: unknown): never => {
      continuations.push(input);
      // THROWS, like the real one: nothing after `continueAs` runs, so a fake
      // that returned would let a spec pass on code the engine never reaches.
      // Recorded first, so the input is observable from the catch.
      throw new Error("ctx.continueAs unwound the run (test context)");
    },
    waitFor: (name: string): never => {
      waits.push(name);
      // THROWS for the same reason `continueAs` does: a waitpoint is RELEASED and
      // woken by an HTTP signal, so nothing after it runs in this execution. A
      // stub that resolved would let a spec pass on a body the engine never
      // reaches on a first execution — pass `waitFor` to script the answer.
      throw new Error(`ctx.waitFor("${name}") parked the run (test context)`);
    },
    steps,
    sleeps,
    continuations,
    waits,
    ...overrides,
  };
}
