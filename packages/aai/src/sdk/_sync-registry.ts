// Copyright 2026 the AAI authors. MIT license.
/**
 * The projections `sessionSlot(key, create, { sync: true })` registers, for
 * `agent()` to collect when an agent declares no `syncState` of its own.
 *
 * Module state, and copy-local on purpose: an agent bundle carries its own SDK
 * copy (see "The bundle/runtime boundary" in `packages/aai/CLAUDE.md`), so a
 * slot declared in the bundle's `shared.ts` and the `agent()` call in its
 * `agent.ts` meet in ONE registry, while a host's own copy — the runtime, a
 * spec's harness — reads an empty one and adds nothing to a definition it was
 * handed. That is the correct side for a registry to err on: the host never
 * syncs a slot the agent did not declare.
 *
 * Declaration ORDER is kept, so the frame's key order is the module order, and
 * a key declared twice is left for `normalizeSyncState` to refuse at `agent()`
 * — the one place that already names the collision.
 *
 * Internal (`_`-prefixed): `session-slot.ts` writes, `_author-conveniences.ts`
 * reads, nothing else touches it.
 *
 * @module _sync-registry
 */

import type { StateProjection } from "./session-state.ts";

const synced: StateProjection[] = [];

/** Record a projection for `agent()` to sync by default. */
export function registerSyncedProjection(projection: StateProjection): void {
  synced.push(projection);
}

/** Every projection registered so far, in declaration order. */
export function syncedProjections(): readonly StateProjection[] {
  return synced;
}
