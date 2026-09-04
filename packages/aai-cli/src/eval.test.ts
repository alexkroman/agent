// Copyright 2026 the AAI authors. MIT license.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { silenced } from "./_test-utils.ts";
import { EVAL_TEST_TIMEOUT_MS, executeEval } from "./eval.ts";

const execaSync = vi.hoisted(() => vi.fn());
vi.mock("execa", async (importOriginal) => {
  const orig = await importOriginal<typeof import("execa")>();
  return { ...orig, execaSync };
});

/** The channel `runVitest`'s unrun-spec notice goes out on. */
const notify = vi.hoisted(() => vi.fn());
vi.mock("./_ui.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./_ui.ts")>();
  return { ...orig, notify };
});

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aai-eval-"));
  execaSync.mockReset();
  notify.mockReset();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** The vitest invocation `executeEval` made. */
function invocation(): { args: string[]; opts: { cwd: string; env?: Record<string, string> } } {
  const [, args, opts] = execaSync.mock.calls[0] as [
    string,
    string[],
    { cwd: string; env?: Record<string, string> },
  ];
  return { args, opts };
}

describe("executeEval", () => {
  test("skips, saying what to create, when the project has no eval file", async () => {
    const result = await silenced(() => executeEval(tempDir))(tempDir);
    expect(result).toEqual({ ok: true, data: { passed: true, skipped: true, ran: [] } });
    expect(execaSync).not.toHaveBeenCalled();
  });

  test("does not pick up the unit test file — the two commands are disjoint", async () => {
    await writeFile(path.join(tempDir, "agent.test.ts"), "// unit test");
    const result = await silenced(() => executeEval(tempDir))(tempDir);
    expect(result).toEqual({ ok: true, data: { passed: true, skipped: true, ran: [] } });
    expect(execaSync).not.toHaveBeenCalled();
  });

  test("runs agent.eval.test.ts with a budget a live model turn can meet", async () => {
    await writeFile(path.join(tempDir, "agent.eval.test.ts"), "// eval file");
    const result = await silenced(() => executeEval(tempDir))(tempDir);
    expect(result).toEqual({ ok: true, data: { passed: true, ran: ["agent.eval.test.ts"] } });
    const { args, opts } = invocation();
    expect(args.slice(-6)).toEqual([
      "run",
      "--root",
      ".",
      "--testTimeout",
      String(EVAL_TEST_TIMEOUT_MS),
      "agent.eval.test.ts",
    ]);
    expect(opts.cwd).toBe(tempDir);
    // Vitest's 5s default is shorter than one live model turn, so the flag is
    // the difference between measuring the agent and reporting a timeout.
    expect(EVAL_TEST_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  test("hands the project's .env to the eval, since that is where the key lives", async () => {
    await writeFile(path.join(tempDir, "agent.eval.test.ts"), "// eval file");
    await writeFile(path.join(tempDir, ".env"), "ASSEMBLYAI_API_KEY=from-dot-env\n");
    await silenced(() => executeEval(tempDir))(tempDir);
    const { opts } = invocation();
    expect(opts.env?.ASSEMBLYAI_API_KEY).toBe("from-dot-env");
    // The rest of the parent environment is still inherited — a key exported in
    // the shell has to keep working too.
    expect(opts.env?.PATH).toBe(process.env.PATH);
  });

  test("falls back to agent.eval.test.js", async () => {
    await writeFile(path.join(tempDir, "agent.eval.test.js"), "// eval file");
    await silenced(() => executeEval(tempDir))(tempDir);
    expect(invocation().args.at(-1)).toBe("agent.eval.test.js");
  });

  test("reports a failed eval as an eval failure, not a test failure", async () => {
    await writeFile(path.join(tempDir, "agent.eval.test.ts"), "// eval file");
    execaSync.mockImplementation(() => {
      throw new Error("exit 1");
    });
    const result = await silenced(() => executeEval(tempDir))(tempDir);
    expect(result).toEqual({ ok: false, code: "test_failed", error: "Evals failed: exit 1" });
  });

  test("an eval run never names the project's unit specs as skipped", async () => {
    // `unrunSpecFiles` drops eval files by infix, so the notice `aai build`
    // gets from `runVitest` would, left on here, list every unit spec in the
    // project as "NOT run" during `aai eval`. True and not this command's
    // business — `aai test` is what reports and refuses that set.
    await writeFile(path.join(tempDir, "agent.eval.test.ts"), "// eval file");
    await writeFile(path.join(tempDir, "agent.test.ts"), "// unit test");
    await writeFile(path.join(tempDir, "store.test.ts"), "// unit test");
    await silenced(() => executeEval(tempDir))(tempDir);
    expect(notify).not.toHaveBeenCalled();
  });

  test("reports a runner that could not be spawned as infrastructure", async () => {
    await writeFile(path.join(tempDir, "agent.eval.test.ts"), "// eval file");
    execaSync.mockImplementation(() => {
      const err = new Error("spawnSync npx ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const result = await silenced(() => executeEval(tempDir))(tempDir);
    expect(result).toMatchObject({ ok: false, code: "spawn_failed" });
  });
});
