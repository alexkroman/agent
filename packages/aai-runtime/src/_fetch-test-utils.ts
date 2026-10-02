// Copyright 2025 the AAI authors. MIT license.

import { vi } from "vitest";

/**
 * Narrow a test double to `fetch`'s type, in ONE place: a fake never matches
 * `typeof globalThis.fetch` structurally (`RequestInfo | URL`, a full
 * `Response`, `preconnect`), and a cast per call site is the alternative.
 */
export function fakeFetch(
  fn: (url: string, init: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  // One CHECKED cast: `fetch` is assignable to `fn`'s narrower type, so the
  // compiler still relates the two.
  return fn as typeof globalThis.fetch;
}

/** One request the implementation made, reduced to what a spec asks about. */
export type ScriptedCall = {
  method: string;
  url: string;
  headers: Record<string, string>;
  bytes: number;
};

/**
 * A `fetch` that records and answers whatever a spec scripted.
 *
 * Shared by the two upload byte backends' specs (`uploads/blobs-http.test.ts`,
 * `uploads/blobs-brokered.test.ts`), which assert the REQUEST each operation composes.
 */
export function scriptedFetch(answer: (call: ScriptedCall) => Response) {
  const calls: ScriptedCall[] = [];
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const body = init?.body;
    const call: ScriptedCall = {
      method: init?.method ?? "GET",
      url: String(input),
      headers,
      bytes: body instanceof Uint8Array ? body.length : 0,
    };
    calls.push(call);
    return answer(call);
  });
  // `vi.mocked`-free and cast-free: the seam is typed as `typeof globalThis.fetch`, so
  // the fake is DECLARED as one rather than laundered into one — a cast here would stop
  // reporting the moment either signature moved.
  const seam: typeof globalThis.fetch = async (input, init) =>
    await fetch(String(input), init as RequestInit | undefined);
  return { calls, fetch: seam };
}
