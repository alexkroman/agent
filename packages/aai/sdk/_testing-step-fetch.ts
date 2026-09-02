// Copyright 2026 the AAI authors. MIT license.
/**
 * `stubStepFetch` — the published `stepFetch` a spec answers with, so a
 * step's HTTP is assertable without a server.
 *
 * Split out of `sdk/testing.ts` to break a cycle rather than for length:
 * `_testing-transcribe.ts` builds its provider fake ON this one, and
 * `sdk/testing.ts` re-exports both. Everything here is re-exported from
 * `sdk/testing.ts`; nothing outside this package imports this module by name.
 *
 * @module _testing-step-fetch
 */

import { collectBytes } from "./_bytes.ts";
import { publishStepFetch, type StepFetchInit } from "./step-fetch.ts";

/**
 * Collect a request body into the bytes that went out.
 *
 * A streaming body is an async iterable consumed ONCE, so a recorder that stored the
 * iterable would hand a spec something the request had already eaten. Draining here
 * is also what makes the two body shapes indistinguishable to an assertion.
 */
async function drainBody(
  body: Uint8Array | string | AsyncIterable<Uint8Array> | undefined,
): Promise<Uint8Array | string | undefined> {
  if (body === undefined || typeof body === "string" || body instanceof Uint8Array) return body;
  return collectBytes(body);
}

/** One request a {@link stubStepFetch} recorder captured. */
export type StubStepRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  /**
   * The body as sent.
   *
   * A STREAMING body (an async iterable — see `StepFetchInit.body`) is DRAINED into
   * a `Uint8Array` before it reaches a spec, so an assertion reads the bytes that
   * went out rather than an iterator it would have to consume itself — and
   * consuming it in the spec would be consuming the one the request was going to
   * send.
   */
  body: Uint8Array | string | undefined;
};

/**
 * What a {@link stubStepFetch} answer may be: a whole `Response`, or the
 * `{ status, body, headers }` shorthand that JSON-encodes `body`.
 *
 * Named because the transcription fake (`stubTranscribe`) hands its
 * `otherwise` handler the same vocabulary, and a spec routing by URL should not
 * have to restate the union to write one.
 *
 * @public
 */
export type StubStepAnswer =
  | Response
  | { status?: number; body?: unknown; headers?: Record<string, string> };

/** What {@link stubStepFetch} returns. */
export type StubStepFetch = {
  /** Every request the step made, in order. */
  calls: StubStepRequest[];
  /** Unpublish. Call it in an `afterEach` — see {@link stubStepFetch}. */
  restore: () => void;
};

/**
 * Turn a {@link StubStepAnswer} into the `Response` a step will read.
 *
 * Shared with `stubTranscribe`, which routes the transcription endpoints itself
 * and hands everything else to the caller's own handler — both have to encode
 * the shorthand the same way or a spec's `otherwise` would behave differently
 * from its `stubStepFetch`.
 */
export function toStepResponse(answered: StubStepAnswer): Response {
  if (answered instanceof Response) return answered;
  // A JSON body is what nearly every endpoint a step calls answers with, so
  // the shorthand encodes one rather than making each spec stringify.
  const body =
    typeof answered.body === "string" ? answered.body : JSON.stringify(answered.body ?? {});
  return new Response(body, {
    status: answered.status ?? 200,
    headers: { "Content-Type": "application/json", ...answered.headers },
  });
}

/**
 * Publish a fake `stepFetch`, so a step's HTTP can be asserted
 * without a server and without stubbing a global.
 *
 * A step's outbound call goes through a process-wide slot rather than
 * `globalThis.fetch` (see `stepFetch` on `@alexkroman1/aai/step` for why —
 * HTTP/1.1 pinning, and a fan-out that breaks on HTTP/2 stream resets), so this is the honest way to
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
 * `installStubStepFetch` (`@alexkroman1/aai/testing/vitest`) is the same fake
 * with that registration already done.
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
  answer: (request: StubStepRequest) => StubStepAnswer | Promise<StubStepAnswer> = () => ({}),
): StubStepFetch {
  const calls: StubStepRequest[] = [];
  publishStepFetch(async (url: string, init: StepFetchInit = {}): Promise<Response> => {
    const request = await recordRequest(url, init);
    calls.push(request);
    return toStepResponse(await answer(request));
  });
  return { calls, restore: () => publishStepFetch(undefined) };
}

/**
 * The recorded form of one outbound step request.
 *
 * Its own function because `stubTranscribe` records the same way — a spec that
 * moves from one fake to the other must not find the body drained differently.
 */
export async function recordRequest(url: string, init: StepFetchInit): Promise<StubStepRequest> {
  return {
    url,
    method: init.method ?? "GET",
    headers: { ...init.headers },
    body: await drainBody(init.body),
  };
}
