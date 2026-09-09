// Copyright 2026 the AAI authors. MIT license.
/**
 * Test helpers only the harness entry needs.
 *
 * The shared ones are `aai-guest-core/test-utils`. `stubProcessExit` belongs
 * here because only this package's crash-guard specs stub the exit — the one
 * typed seam for that cast, whose argument is below.
 */

import { type MockInstance, vi } from "vitest";
/**
 * Stub `process.exit` and hand back the spy, so a spec can assert on whether the
 * guest would have died without dying.
 *
 * The ONE typed seam for that cast, which is what earns it. `process.exit` is
 * declared to return `never`, so a stub that returns normally cannot satisfy the
 * signature and every call site reached for `(() => undefined) as never` — eleven
 * of them across the crash-guard specs, each independently laundering a value past
 * the checker. `as never` is the strongest laundering there is (`never` is
 * assignable to everything, so it also stops reporting when the signature CHANGES),
 * and the repo's rule for a concentration of identical casts is one narrowing in
 * one helper rather than one per assertion.
 *
 * `restoreMocks` puts the real `process.exit` back before the next test, so there
 * is nothing to undo here.
 */
export function stubProcessExit(): MockInstance<(code?: number) => never> {
  return vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
}
