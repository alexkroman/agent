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
import { publishUploadReader } from "./step-uploads.ts";
import type { DefaultSessionState, ToolContext } from "./types.ts";
import type { WorkflowClient } from "./workflow.ts";
import { rejectingWorkflows } from "./workflow-unavailable.ts";

export {
  type StubGateway,
  type StubGatewayCall,
  type StubGatewayOptions,
  stubGateway,
} from "./testing-gateway.ts";

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
 * Rejecting rather than no-op defaults for the same reason {@link createUnusedDb}
 * rejects — a tool that reaches for a method the test did not stub should say so,
 * not silently receive `undefined`. `listing` is the exception and returns `[]`,
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

/**
 * One file a {@link stubUploads} store answers for.
 *
 * A bare `Uint8Array` is the common case and means "these bytes, no name".
 *
 * @public
 */
export type StubUpload = Uint8Array | { bytes: Uint8Array; name?: string; type?: string };

/**
 * Publish an in-memory upload store, so a `"use step"` function that calls
 * `readUpload` can be tested without a server.
 *
 * A step reads uploads through a process-wide slot rather than dialling
 * anything (see `sdk/step-uploads.ts`), which is what makes this possible at
 * all: a spec supplies its own bytes and the step under test is unchanged.
 *
 * Returns the UNPUBLISH function, and calling it in an `afterEach` is not
 * optional — a store left published makes the next file's steps read this
 * one's bytes, which is the kind of cross-file leak that presents as a passing
 * test somewhere else.
 *
 * @example
 * ```ts
 * import { stubUploads } from "@alexkroman1/aai/testing";
 *
 * const restore = stubUploads({ upl_1: new Uint8Array([1, 2, 3]) });
 * // … call the step …
 * restore();
 * ```
 *
 * @param files - Keyed by upload id — the same string a run input would carry.
 * @public
 */
export function stubUploads(files: Readonly<Record<string, StubUpload>>): () => void {
  const stored = new Map(
    Object.entries(files).map(([id, file]) => [
      id,
      file instanceof Uint8Array ? { bytes: file } : file,
    ]),
  );
  publishUploadReader({
    info: (id) => {
      const file = stored.get(id);
      return Promise.resolve(
        file
          ? { id, name: file.name ?? "", type: file.type ?? "", size: file.bytes.length }
          : undefined,
      );
    },
    read: (id, start, end) =>
      Promise.resolve(stored.get(id)?.bytes.subarray(start, end) ?? new Uint8Array(0)),
  });
  return () => publishUploadReader(undefined);
}
