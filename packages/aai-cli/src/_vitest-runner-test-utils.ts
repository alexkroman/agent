// Copyright 2026 the AAI authors. MIT license.
/**
 * Fixtures for the specs of `runVitest` and the two commands over it
 * (`aai test`, `aai eval`).
 */
import { type Mock, type MockInstance, vi } from "vitest";
import { test as baseTest, createFakeUi, type FakeUi } from "./_test-utils.ts";
import type { VitestExec } from "./_vitest-runner.ts";

/**
 * The package `test` (with `tmpDir` as the project), plus:
 *
 * - `exec`: the spawner `runVitest` is handed in place of `execaSync`.
 * - `ui`: the fake terminal.
 * - `notify`: a spy on `ui.notify` — the channel the unrun-spec notice goes out
 *   on (not `log`, which JSON mode silences).
 * - `deps`: `{ ui, exec }`, as the executors take them.
 */
export const test = baseTest
  .extend("exec", (): Mock<VitestExec> => vi.fn<VitestExec>())
  .extend("ui", (): FakeUi => createFakeUi())
  .extend("notify", ({ ui }): MockInstance<FakeUi["notify"]> => vi.spyOn(ui, "notify"))
  .extend("deps", ({ ui, exec }) => ({ ui, exec }));

/** The `[cmd, args, opts]` of the first vitest invocation `exec` received. */
export function invocation(exec: Mock<VitestExec>): {
  cmd: string;
  args: string[];
  opts: { cwd: string; env?: NodeJS.ProcessEnv };
} {
  const call = exec.mock.calls[0];
  if (call === undefined) throw new Error("vitest was never spawned");
  const [cmd, args, opts] = call;
  return { cmd, args, opts };
}
