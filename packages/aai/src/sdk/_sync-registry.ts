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
 * a key declared twice is left for `keyedBySlot` (`_author-conveniences.ts`) to refuse at `agent()`
 * — the one place that already names the collision.
 *
 * ## An entry is CLAIMED by the first def that collects it
 *
 * The registry is read whole and never drained, so in a process that declares
 * several agents — a template suite, a monorepo spec, a page-mount test —
 * every agent declared AFTER a `sync: true` slot used to inherit that
 * projection, and a `workflowApp()` declared after one then met its own
 * "`syncState` has no effect on a workflow-app agent" refusal. So a projection
 * is claimed by the first def that collects it; a later def collects only
 * what is still unclaimed; and a workflow-app def never collects (see
 * `resolveSyncState`). A def re-collecting at the lowering keeps what it
 * already holds and claims only the new entries.
 *
 * ## A collected `syncState` is re-collected at the lowering
 *
 * `agent()` runs when `agent.ts` is evaluated, and the generated bundle entry
 * imports `agent.ts` FIRST and the `tools/*.ts` modules after it — so a slot
 * declared `sync: true` in a tool module registers after the agent was built
 * without it. The entry then lowers the tools onto the def (`withTools`) and
 * crosses the config boundary (`toAgentConfig`), both after every module has
 * evaluated, and the def's `syncState` is extended there with what is still
 * unclaimed. Nobody authors the field (`agent()` refuses the key), so every
 * record is one this registry produced and extending it is always right.
 *
 * Internal (`_`-prefixed): `session-slot.ts` writes, `_author-conveniences.ts`
 * reads, nothing else touches it.
 *
 * @module _sync-registry
 */

import type { StateProjection } from "./session-state.ts";

const synced: StateProjection[] = [];

/**
 * The projections some def has already collected — see the module doc.
 *
 * Claiming assumes the BUNDLE's evaluation order — `agent.ts` first, then the
 * `tools/` modules `withTools` loads — so a loader that evaluates several
 * agents' slot modules before any of their `agent()` calls (a test harness
 * globbing every template eagerly) hands the first agent every projection.
 * Load one agent's modules at a time, as `aai-templates`' `_discovery.ts` does.
 */
const claimed = new WeakSet<StateProjection>();

/** Record a projection for `agent()` to sync by default. */
export function registerSyncedProjection(projection: StateProjection): void {
  synced.push(projection);
}

/** Every projection registered so far, in declaration order, claimed or not. */
export function syncedProjections(): readonly StateProjection[] {
  return synced;
}

/**
 * The registered projections no def has collected yet, in declaration order
 * — and CLAIM them for the caller, so the next def collects none of them.
 */
export function claimUnsyncedProjections(): StateProjection[] {
  const fresh = synced.filter((projection) => !claimed.has(projection));
  for (const projection of fresh) claimed.add(projection);
  return fresh;
}
