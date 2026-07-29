// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared test helpers for the fetch-based sdk providers (send channels,
 * sync transcription) and the host code exercising them.
 */

import { vi } from "vitest";

/** Argument tuple of one recorded fetch call. */
export type FetchMockArgs = [input: string | URL | Request, init?: RequestInit];

/** A fetch-shaped vi.fn with typed recorded calls. */
export type FetchMock = typeof globalThis.fetch & {
  mock: { calls: FetchMockArgs[] };
} & ReturnType<typeof vi.fn>;

/** Build a fetch mock that answers every call with `response()`. */
export function fetchMock(response: () => Response): FetchMock {
  return vi.fn(async (..._args: FetchMockArgs) => response()) as unknown as FetchMock;
}

/** A fetch mock answering 200 with the given JSON body. */
export function fetchMockJson(body: unknown): FetchMock {
  return fetchMock(() => new Response(JSON.stringify(body), { status: 200 }));
}
