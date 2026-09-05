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
import { createMemoryWorkspaceStore, type WorkspaceStore } from "aai-server/stores";
import { captureLogs } from "aai-server/test-utils";
import { vi } from "vitest";
import {
  createWorkspace,
  getWorkspace,
  mutateWorkspace,
  type StudioWorkspace,
} from "./studio-workspace.ts";

export const SCOPE = "scope";
export const PROJECT = "contact-form-x7k2mq";
export const TARGET = { serverUrl: "https://platform.example", apiKey: "caller-key" };

export function makeStore() {
  return createMemoryWorkspaceStore();
}

/**
 * A store holding THE shared project, seeded with `files`.
 *
 * Both suites open almost every case with this pair of statements, and the pair
 * is not incidental: `wakeProjectPreview` and the deploy loop both read the
 * workspace by (SCOPE, PROJECT), so a case that seeded a different project
 * would exercise the "no such project" path while reading as a real scenario.
 */
export async function seededStore(
  files: Record<string, string> = { "agent.ts": "// v1" },
): Promise<WorkspaceStore> {
  const workspaces = makeStore();
  await createWorkspace(workspaces, SCOPE, PROJECT, { files });
  return workspaces;
}

/**
 * Put the shared project into the state a deploy would have left it in —
 * `previewSlug`/`previewHash`/`previewError`, or a file edit.
 *
 * Takes the fields, not the whole document: every call site spread `...current`
 * by hand purely to satisfy the read-modify-write, which buried the two or
 * three fields the case is actually about.
 */
export function stampProject(
  workspaces: WorkspaceStore,
  stamp: Partial<StudioWorkspace> | ((current: StudioWorkspace) => Partial<StudioWorkspace>),
): Promise<StudioWorkspace | null> {
  return mutateWorkspace(workspaces, SCOPE, PROJECT, (current) => ({
    ...current,
    ...(typeof stamp === "function" ? stamp(current) : stamp),
  }));
}

/**
 * Wait until a preview deploy has stamped the shared project, and hand back the
 * workspace it stamped — the document the case then reads its own assertions
 * off.
 *
 * A THROW rather than an `expect`: `vi.waitFor` retries on either, and an
 * assertion inside a shared helper is one that no longer belongs to the test
 * that called it (Biome's `noMisplacedAssertion`, and the reason
 * `check-test-assertions.mjs` wants every case to assert for itself). Waiting
 * is this helper's job; asserting is the caller's.
 */
export function previewStamped(workspaces: WorkspaceStore): Promise<StudioWorkspace> {
  return vi.waitFor(async () => {
    const workspace = await getWorkspace(workspaces, SCOPE, PROJECT);
    if (workspace?.previewHash === undefined) throw new Error("no previewHash stamped yet");
    return workspace;
  });
}

/**
 * Keep the EXPECTED warnings out of the test output, and hand back the reader
 * for the cases that assert on them.
 *
 * Through the package's log SEAM (`captureLogs`) rather than
 * `spyOn(console, "warn")` — a silencing spy is test scaffolding standing in
 * for the abstraction `aai-server/logger.ts` exists to provide. It registers
 * its own `beforeEach`/`afterEach`, so call it at DESCRIBE scope, once, rather
 * than inside a test body.
 */
export function previewLogs(): ReturnType<typeof captureLogs> {
  return captureLogs();
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
