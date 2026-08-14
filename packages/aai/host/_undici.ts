// Copyright 2026 the AAI authors. MIT license.
/**
 * The one seam between this package's `undici` and the ambient `fetch` types.
 *
 * Two modules build an undici `Agent` and hand it to a `fetch` — `ssrf.ts`
 * (pinning a validated IP) and `step-fetch.ts` (pinning HTTP/1.1) — and both
 * pay the same two-line bridge to do it. A concentration of identical casts is
 * a missing typed seam, so this is it: the casts live here once, with the
 * reason, and neither caller restates them.
 *
 * ## Why a cast is needed at all
 *
 * `@types/node` declares `RequestInit.dispatcher` through its own bundled
 * `undici-types` — a different copy of the declarations from the `undici`
 * package the `Agent` comes from, structurally identical and nominally
 * incompatible. And the ambient `RequestInit` that wins depends on the
 * consumer's `lib`: a program with `lib.dom` gets the DOM's, which has no such
 * property at all. So the bridge has to hold whichever way the type resolved,
 * which no assignment can express.
 *
 * ## Why the fetch must come from the same package as the dispatcher
 *
 * `globalThis.fetch` is backed by the undici copy inside the Node runtime
 * (`process.versions.undici`), a different major. undici 8 reworked the
 * dispatch-handler interface, so a v8 `Agent` rejects the v7-style handler
 * Node's internal fetch builds, with `InvalidArgumentError: invalid
 * onRequestStart method` surfacing as a bare `TypeError: fetch failed`. A
 * dispatcher is attached to every request, so the mismatch takes out all
 * dispatcher-using egress at once. `ssrf-dispatcher.test.ts` guards the
 * pairing.
 *
 * The corollary, which bites bodies rather than dispatchers: undici 8
 * brand-checks each body type with an `instanceof` against **its own** classes,
 * so a `globalThis.FormData`/`Blob`/`Headers` matches no branch and falls
 * through to string conversion — `Content-Type: text/plain` with the 17-byte
 * body `[object FormData]`. Never hand one of those to {@link pinnedFetch};
 * pass bytes.
 *
 * @internal
 */

import type { Agent } from "undici";
import { fetch as undiciFetch } from "undici";

/**
 * The `fetch` every dispatcher-bearing request must go through — deliberately
 * NOT `globalThis.fetch`, and NOT SSRF-checked itself.
 *
 * @internal
 */
export const pinnedFetch = undiciFetch as unknown as typeof globalThis.fetch;

/**
 * The dispatcher type `fetch` accepts — INFERRED, so that a `RequestInit`
 * without the property is not an error.
 *
 * It used to be `NonNullable<RequestInit["dispatcher"]>`, an indexed access,
 * which resolves only when `@types/node` is the copy of `RequestInit` that
 * wins. A program that also has `lib.dom` gets the DOM's, which has no such
 * property, and the module then failed to compile in EVERY such consumer —
 * not hypothetically: `@alexkroman1/aai/tools` re-exports the builtins for an
 * author's own tool and step code, so the consumer is an ordinary agent
 * project, whose `client.tsx` needs the DOM lib. It surfaced the moment a
 * template imported that subpath from a step.
 *
 * A conditional with `infer` reads the property where it exists and degrades to
 * `unknown` where it does not, which is the honest answer in a program that has
 * no undici types to name. The intersection form (`RequestInit & { dispatcher?:
 * unknown }`) does NOT work: where the ambient property exists the intersection
 * is with `Dispatcher`, and under `exactOptionalPropertyTypes` the two halves
 * are then incompatible rather than redundant.
 *
 * @internal
 */
export type FetchDispatcher = RequestInit extends { dispatcher?: infer D } ? NonNullable<D> : never;

/**
 * `RequestInit` with that property present whether or not the ambient one has it.
 *
 * @internal
 */
export type PinnedRequestInit = RequestInit & { dispatcher?: FetchDispatcher };

/**
 * An `Agent` as the thing `fetch` will accept — the bridge this module exists for.
 *
 * @internal
 */
export function asDispatcher(agent: Agent): FetchDispatcher {
  return agent as unknown as FetchDispatcher;
}
