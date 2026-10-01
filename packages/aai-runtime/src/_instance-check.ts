// Copyright 2026 the AAI authors. MIT license.
/**
 * Where every copy of this package in the process was loaded from.
 *
 * Two copies in one process are legitimate in a SELF-HOSTED host (its runtime
 * serves an agent bundle that inlines another) and the one registry that crosses
 * them is a registered slot (`metrics-sink.ts`). In a deployed guest they are
 * not: the harness carries no runtime and drives the agent through the bundle's
 * (`guest-host.ts`), so a second URL here means a harness that loaded one of its
 * own — which the guest checks after boot (`aai-guest/harness/agent-mode.ts`)
 * and the artifact gate (`harness/externals.test.ts`) rules out at build time.
 *
 * Recording only: this module decides nothing, because only the host knows how
 * many copies it should have. The record is a URL set, not a counter, so
 * `vi.resetModules()` and vitest's per-file isolation — which re-evaluate ONE
 * file — never read as a second install.
 *
 * @module
 */

import { globalSlot } from "@alexkroman1/aai/internal";

const INSTANCES = globalSlot<Set<string>>("runtimeInstances");

/**
 * Record that a copy of this package loaded from `url`.
 *
 * @internal
 */
export function recordRuntimeInstance(url: string): void {
  const seen = INSTANCES.get() ?? new Set<string>();
  seen.add(url);
  INSTANCES.set(seen);
}

/**
 * Every copy recorded so far, by module URL.
 *
 * @internal
 */
export function runtimeInstances(): readonly string[] {
  return [...(INSTANCES.get() ?? [])];
}
