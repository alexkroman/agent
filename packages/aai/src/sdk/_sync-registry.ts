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
 * ## A collected `syncState` is re-collected at the lowering
 *
 * `agent()` runs when `agent.ts` is evaluated, and the generated bundle entry
 * imports `agent.ts` FIRST and the `tools/*.ts` modules after it — so a slot
 * declared `sync: true` in a tool module registers after the agent was built
 * without it. The entry then lowers the tools onto the def (`withTools`) and
 * crosses the config boundary (`toAgentConfig`), both after every module has
 * evaluated, and a `syncState` this registry produced is re-collected there.
 * One the author DECLARED is never touched; the two are told apart by
 * {@link isCollectedSyncState}, an identity mark on the record this registry
 * handed out, so a declared record can never be mistaken for one.
 *
 * Internal (`_`-prefixed): `session-slot.ts` writes, `_author-conveniences.ts`
 * reads, nothing else touches it.
 *
 * @module _sync-registry
 */

import { isRecord } from "./is-record.ts";
import type { StateProjection } from "./session-state.ts";

const synced: StateProjection[] = [];

/** The `syncState` records this registry's contents were collected into. */
const collected = new WeakSet<object>();

/** Mark `record` as collected from this registry rather than declared. */
export function markCollectedSyncState(record: object): void {
  collected.add(record);
}

/** Whether `value` is a `syncState` record this registry collected — see the module doc. */
export function isCollectedSyncState(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && collected.has(value);
}

/** Record a projection for `agent()` to sync by default. */
export function registerSyncedProjection(projection: StateProjection): void {
  synced.push(projection);
}

/** Every projection registered so far, in declaration order. */
export function syncedProjections(): readonly StateProjection[] {
  return synced;
}
