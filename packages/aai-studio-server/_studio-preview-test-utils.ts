// Copyright 2026 the AAI authors. MIT license.
/**
 * Fixtures shared by the two preview suites — `studio-preview.test.ts` (the
 * "landing on a project" half: slug derivation, sandbox warm-up, the wake) and
 * `studio-preview-deploy.test.ts` (the deploy loop and its durable queue).
 *
 * Shared rather than duplicated because both halves talk about the same
 * project: a drifting SCOPE/PROJECT pair between them would make the two files
 * describe two different tenants while reading identically.
 */

import { sleep } from "@alexkroman1/aai/internal";
import { createMemoryWorkspaceStore } from "aai-server/workspace-store";

export const SCOPE = "scope";
export const PROJECT = "contact-form-x7k2mq";
export const TARGET = { serverUrl: "https://platform.example", apiKey: "caller-key" };

export function makeStore() {
  return createMemoryWorkspaceStore();
}

/**
 * Let the fire-and-forget deploy loop run to a standstill.
 *
 * This gates about ten `not.toHaveBeenCalled()` assertions, so what it waits
 * for is load-bearing — and it used to wait for nothing measurable. The
 * `await vi.waitFor(() => Promise.resolve())` it opened with succeeds on its
 * FIRST attempt (a resolved promise is a passing check), and the bare
 * macrotask behind it is enough only because every step in these paths is a
 * microtask over in-memory stores: the moment one acquires a real timer or a
 * second turn, every negative assertion goes vacuous with no signal at all.
 *
 * Several turns instead of one, through the SDK's own `sleep` (guard rule 19),
 * because each macrotask drains the whole microtask queue behind it — so an
 * N-await chain settles in N turns rather than in the one it happens to need
 * today.
 */
export async function settled(turns = 5): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await sleep(0);
}
