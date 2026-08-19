// Copyright 2026 the AAI authors. MIT license.
/**
 * The one typed `fetch` double, for the two suites whose subject is an HTTP
 * call this package makes: the preview warm-up (`warmPreviewSandbox`) and the
 * peer session install (`adoptPeerSession`).
 *
 * Both used to build their own untyped `vi.fn()` and cast it in at every call
 * site — eight casts between them, plus a second cast on the READ side to
 * narrow the recorded call before asserting on it. A cast at either end stops
 * reporting the day `fetch`'s own shape moves, which is exactly what these
 * assertions exist to watch.
 */

import { type Mock, vi } from "vitest";

/** A `fetch` whose every call is answered by `answer`. */
export function fakeFetch(
  answer: () => Promise<Response> = () => Promise.resolve(new Response("{}")),
): Mock<typeof globalThis.fetch> {
  return vi.fn<typeof globalThis.fetch>(answer);
}

/** An answer for {@link fakeFetch}: one response, with a status worth naming. */
export const answering = (body: string, status: number) => (): Promise<Response> =>
  Promise.resolve(new Response(body, { status }));
