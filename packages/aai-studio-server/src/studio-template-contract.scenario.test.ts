// Copyright 2026 the AAI authors. MIT license.
/**
 * `spawnCommand`, the template-contract harness's real spawner, against real
 * `node` child processes — a subprocess puts it in the scenario tier. The rest
 * of the harness is covered with the spawn faked in
 * `studio-template-contract.test.ts`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { spawnCommand } from "./studio-template-contract.ts";

/** A real directory for the child's cwd, removed when the test finishes. */
async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "aai-contract-spawn-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("spawnCommand", () => {
  test("a green command reports code 0", async () => {
    const result = await spawnCommand("node", ["-e", ""], { env: {}, timeoutMs: 10_000 })(
      process.cwd(),
    );
    expect(result.code).toBe(0);
  });

  test("a non-zero exit is reported, not thrown", async () => {
    const result = await spawnCommand("node", ["-e", "process.exit(3)"], {
      env: {},
      timeoutMs: 10_000,
    })(process.cwd());
    expect(result.code).toBe(3);
  });

  test("BOTH streams are captured", async () => {
    // A vitest failure writes its assertion to stdout and its summary to
    // stderr; keeping one loses half the only diagnostic the note carries.
    const result = await spawnCommand(
      "node",
      ["-e", "process.stdout.write('OUT');process.stderr.write('ERR');process.exit(1)"],
      { env: {}, timeoutMs: 10_000 },
    )(process.cwd());
    expect(result.output).toContain("OUT");
    expect(result.output).toContain("ERR");
  });

  test("the child sees the env it was handed", async () => {
    const result = await spawnCommand(
      "node",
      ["-e", "process.stdout.write(process.env.AAI_X??'')"],
      {
        env: { AAI_X: "seen" },
        timeoutMs: 10_000,
      },
    )(process.cwd());
    expect(result.output).toContain("seen");
  });

  test("it runs in the directory it was given", async () => {
    const dir = await scratchDir();
    const result = await spawnCommand("node", ["-e", "process.stdout.write(process.cwd())"], {
      env: {},
      timeoutMs: 10_000,
    })(dir);
    // realpath, because macOS resolves /var to /private/var.
    expect(result.output).toContain(path.basename(dir));
  });

  test("a command that cannot start resolves as a failure", async () => {
    // Not a throw: a contract that could not run is a contract that did not
    // pass, and the reason belongs in the note beside the other failures.
    const result = await spawnCommand("aai-no-such-binary", [], { env: {}, timeoutMs: 10_000 })(
      process.cwd(),
    );
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/ENOENT|not found|spawn/i);
  });

  test("a wedged child is killed and reported rather than hanging", async () => {
    const result = await spawnCommand("node", ["-e", "setTimeout(()=>{}, 60000)"], {
      env: {},
      timeoutMs: 250,
    })(process.cwd());
    expect(result.code).toBe(1);
  });
});
