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
import { createDetachedSlotStore } from "./session-state.ts";
import { publishStepFetch, type StepFetchInit } from "./step-fetch.ts";
import { publishUploadReader } from "./step-uploads.ts";
import type { ToolContext } from "./types.ts";
import type { WorkflowClient } from "./workflow.ts";
import { rejectingWorkflows } from "./workflow-unavailable.ts";

export { withDiscoveredTools } from "./testing-discovery.ts";
export {
  type StubGateway,
  type StubGatewayCall,
  type StubGatewayOptions,
  stubGateway,
} from "./testing-gateway.ts";
export {
  type StubGenerate,
  type StubGenerateCall,
  type StubGenerateReply,
  type StubGenerateRoute,
  stubGenerate,
} from "./testing-generate.ts";
export { runTool, type ToolBearingAgent, toolOf } from "./testing-tools.ts";
export {
  createProgressStream,
  createRunSnapshot,
  type RunSnapshotOverrides,
} from "./testing-workflows.ts";

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
export type TestToolContext = ToolContext & {
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
export function createToolContext(overrides: Partial<ToolContext> = {}): TestToolContext {
  const sent: SentEvent[] = [];
  sessionCounter += 1;
  // Spread LAST so an override wins, including `send` — a test wanting
  // call-order assertions passes `vi.fn()` and reads that instead of `sent`.
  return {
    sessionId: `test-session-${sessionCounter}`,
    env: {},
    // A real slot store, empty, and NOT a stub: it applies the same
    // storability check and the same freeze the deployed one does, so a
    // template holding a `Map` in a slot fails in its own spec rather than on
    // the first deployment that has a database. Each call is a distinct
    // session, so two contexts never share slot values.
    slots: createDetachedSlotStore(),
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

/** One request a {@link stubStepFetch} recorder captured. */
export type StubStepRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The body as sent — BYTES, because that is all `stepFetch` accepts. */
  body: Uint8Array | string | undefined;
};

/** What {@link stubStepFetch} returns. */
export type StubStepFetch = {
  /** Every request the step made, in order. */
  calls: StubStepRequest[];
  /** Unpublish. Call it in an `afterEach` — see {@link stubStepFetch}. */
  restore: () => void;
};

/**
 * Publish a fake `stepFetch`, so a `"use step"` function's HTTP can be asserted
 * without a server and without stubbing a global.
 *
 * A step's outbound call goes through a process-wide slot rather than
 * `globalThis.fetch` (see `sdk/step-fetch.ts` for why — HTTP/1.1 pinning, and
 * a fan-out that breaks on HTTP/2 stream resets), so this is the honest way to
 * intercept it. `vi.stubGlobal("fetch", …)` still works, because an unpublished
 * slot falls back to the global; it just tests a path production does not take,
 * and it cannot see the request BODY as bytes.
 *
 * `answer` may return a `Response`, or a `{ status, body, headers }` shorthand,
 * or throw — a throw is what a connection failure looks like, and `stepFetch`
 * wraps it in a `StepTransportError` exactly as it would in production.
 *
 * Returns `restore`, and calling it in an `afterEach` is not optional — a fetch
 * left published makes the next file's steps answer to this one's handler.
 *
 * @example
 * ```ts no-check
 * // `no-check`: the assertion is the point, and a doc example may not import a
 * // test runner — the same reason `createToolContext`'s example opts out.
 * import { stubStepFetch } from "@alexkroman1/aai/testing";
 *
 * const sync = stubStepFetch(() => ({ body: { text: "hello there" } }));
 * // … call the step …
 * expect(sync.calls[0]?.headers.Authorization).toBe("sk-test");
 * sync.restore();
 * ```
 *
 * @param answer - Called per request with the recorded request. Defaults to an
 *   empty `200`.
 * @public
 */
export function stubStepFetch(
  answer: (
    request: StubStepRequest,
  ) =>
    | Response
    | { status?: number; body?: unknown; headers?: Record<string, string> }
    | Promise<
        Response | { status?: number; body?: unknown; headers?: Record<string, string> }
      > = () => ({}),
): StubStepFetch {
  const calls: StubStepRequest[] = [];
  publishStepFetch(async (url: string, init: StepFetchInit = {}): Promise<Response> => {
    const request: StubStepRequest = {
      url,
      method: init.method ?? "GET",
      headers: { ...init.headers },
      body: init.body,
    };
    calls.push(request);
    const answered = await answer(request);
    if (answered instanceof Response) return answered;
    // A JSON body is what nearly every endpoint a step calls answers with, so
    // the shorthand encodes one rather than making each spec stringify.
    const body =
      typeof answered.body === "string" ? answered.body : JSON.stringify(answered.body ?? {});
    return new Response(body, {
      status: answered.status ?? 200,
      headers: { "Content-Type": "application/json", ...answered.headers },
    });
  });
  return { calls, restore: () => publishStepFetch(undefined) };
}
