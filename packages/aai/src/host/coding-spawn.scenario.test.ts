// Copyright 2026 the AAI authors. MIT license.
/**
 * The capped child-process runner, and the `bash` tool over it.
 *
 * SCENARIO tier: every case here spawns a real process, which is the whole
 * subject — a fake child can be made to agree with any cap, kill note or exit
 * code, and the three things that have gone wrong in this repo (a cap applied
 * to the wrong end of the stream, a kill reading as a clean finish, a child
 * inheriting the parent's environment) are all properties of a real one.
 *
 * `coding-tools.test.ts` covers the other eight tools in the unit tier.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createToolContext } from "../sdk/_testing-context.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import { keepTail, outputWithKillNote, runCapped } from "./coding-spawn.ts";
import { createCodingTools } from "./coding-tools.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aai-coding-spawn-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const bash = (command: string, timeoutMs?: number): Promise<string> =>
  Promise.resolve(
    createCodingTools({ dir, only: ["bash"] }).bash.execute(
      { command, ...omitUndefined({ timeoutMs }) },
      createToolContext(),
    ),
  ).then(String);

/** The environment variable this file leaks into the child on purpose. */
const SECRET = "AAI_CODING_SPAWN_SECRET";

describe("runCapped", () => {
  test("captures both streams, separately by default", async () => {
    const result = await runCapped("bash", ["-c", "echo out; echo err >&2"], {
      cwd: dir,
      timeoutMs: 10_000,
      cap: 1000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
  });

  test("combineStreams interleaves stderr into stdout — the shell-tool shape", async () => {
    const result = await runCapped("bash", ["-c", "echo err >&2"], {
      cwd: dir,
      timeoutMs: 10_000,
      cap: 1000,
      combineStreams: true,
    });
    expect(result.stdout.trim()).toBe("err");
    expect(result.stderr).toBe("");
  });

  test("keeps the TAIL, because a failing command prints its reason last", async () => {
    const result = await runCapped("bash", ["-c", "seq 1 500"], {
      cwd: dir,
      timeoutMs: 10_000,
      cap: 20,
    });
    expect(result.stdout).toContain("500");
    expect(result.stdout).not.toContain("\n1\n");
    // The elision is marked, so a truncated capture cannot read as the whole
    // of what the child printed.
    expect(result.stdout.startsWith("…")).toBe(true);
    expect(keepTail("abcdef", 3)).toBe("…def");
    expect(keepTail("ab", 3)).toBe("ab");
  });

  test("a killed child RESOLVES with its signal, so the caller picks the shape", async () => {
    const result = await runCapped("bash", ["-c", "sleep 30"], {
      cwd: dir,
      timeoutMs: 200,
      cap: 1000,
    });
    expect(result.signal).not.toBeNull();
    expect(outputWithKillNote(result, 200)).toContain("[killed by SIGTERM after 200ms]");
    // An un-killed result is handed back untouched — the note is not a
    // decoration every output gets.
    expect(outputWithKillNote({ ...result, signal: null, stdout: "fine" }, 200)).toBe("fine");
  });

  test("rejects when the command cannot be spawned at all", async () => {
    await expect(
      runCapped("aai-no-such-binary", [], { cwd: dir, timeoutMs: 1000, cap: 10 }),
    ).rejects.toThrow(/ENOENT/);
  });

  test("runs in the directory it is given", async () => {
    const result = await runCapped("bash", ["-c", "pwd"], {
      cwd: dir,
      timeoutMs: 10_000,
      cap: 500,
    });
    // Resolved on both sides: macOS reports /private/var for /var.
    expect(await import("node:fs/promises").then((fs) => fs.realpath(result.stdout.trim()))).toBe(
      await import("node:fs/promises").then((fs) => fs.realpath(dir)),
    );
  });
});

describe("the bash tool", () => {
  test("answers with the command's output", async () => {
    expect(await bash("echo hello")).toBe("hello");
    // A command that prints nothing must not read as a command that did not
    // run: the model's next move depends on telling those apart.
    expect(await bash("true")).toBe("(no output)");
  });

  test("names the exit code of a failure", async () => {
    const out = await bash("echo nope >&2; exit 3");
    expect(out).toContain("[exit code 3]");
    expect(out).toContain("nope");
  });

  test("kills at the deadline and says so", async () => {
    const out = await bash("sleep 30", 1000);
    expect(out).toContain("killed by SIGTERM");
  });

  test("takes the env it is given, and nothing else", async () => {
    // `unstubEnvs` (vitest.shared.ts) takes it back off after this test, so
    // there is no hand-rolled restore to rot.
    vi.stubEnv(SECRET, "leaked");
    expect(await bash(`printenv ${SECRET} || echo absent`)).toBe("leaked");
    const scrubbed = await Promise.resolve(
      createCodingTools({ dir, env: { PATH: process.env.PATH ?? "" } }).bash.execute(
        { command: `printenv ${SECRET} || echo absent` },
        createToolContext(),
      ),
    );
    // The default is this process's environment — right for a CLI, wrong for a
    // sandbox — so a host that holds credentials passes its own allow-list.
    expect(String(scrubbed)).toBe("absent");
  });
});
