// Copyright 2026 the AAI authors. MIT license.
/**
 * The capped runner, driven against a FAKE child process.
 *
 * Its three properties — a kept TAIL rather than a kept head, a killed child
 * that RESOLVES so the caller decides the shape, and a spawn failure that
 * rejects — are properties of how the child is handled rather than of any
 * command, so they are asserted here, in memory, where a test can emit 500
 * bytes against a 20-byte cap or an ENOENT on demand. Same shape and same
 * argument as `ffmpeg.test.ts` beside it.
 *
 * What needs a REAL process is whether the whole thing composes — the `bash`
 * tool over it, an exit code, a deadline that really fires — and that is
 * `coding-spawn.scenario.test.ts`.
 */

import { describe, expect, test, vi } from "vitest";
import { keepTail, outputWithKillNote, runCapped } from "./coding-spawn.ts";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

/**
 * A child the test drives: two output emitters and the two events `runCapped`
 * listens for. Nothing is annotated as a `ChildProcess` — the mocked module's
 * value is untyped, so the fake stands in for one with no cast, which is what
 * keeps this file's escape-hatch count at zero.
 */
function installChild() {
  const data = new Map<string, (chunk: Buffer) => void>();
  const events = new Map<string, (...args: unknown[]) => void>();
  const calls: { cmd: string; args: string[]; options: Record<string, unknown> }[] = [];
  const stream = (name: string) => ({
    on(event: string, cb: (chunk: Buffer) => void) {
      if (event === "data") data.set(name, cb);
      return this;
    },
  });
  const child = {
    stdout: stream("stdout"),
    stderr: stream("stderr"),
    on(event: string, cb: (...args: unknown[]) => void) {
      events.set(event, cb);
      return child;
    },
  };
  spawnMock.mockImplementation((cmd: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ cmd, args, options });
    return child;
  });
  return {
    get call() {
      return calls.at(-1);
    },
    emit: (name: "stdout" | "stderr", text: string) => data.get(name)?.(Buffer.from(text)),
    close: (exitCode: number | null, signal: string | null = null) =>
      events.get("close")?.(exitCode, signal),
    fail: (err: Error) => events.get("error")?.(err),
  };
}

describe("runCapped", () => {
  test("passes the caller's cwd, env and deadline through to the child", async () => {
    const child = installChild();
    const run = runCapped("bash", ["-c", "true"], {
      cwd: "/work",
      env: { PATH: "/usr/bin" },
      timeoutMs: 5000,
      cap: 100,
    });
    child.close(0);
    await run;
    expect(child.call).toMatchObject({
      cmd: "bash",
      args: ["-c", "true"],
      options: {
        cwd: "/work",
        env: { PATH: "/usr/bin" },
        timeout: 5000,
        // Never a pipe: an open stdin the parent never writes lets a child
        // like a bare `cat` block until the deadline instead of seeing EOF.
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
  });

  test("omits `env` entirely when the caller named none, rather than passing undefined", async () => {
    const child = installChild();
    const run = runCapped("bash", [], { cwd: "/work", timeoutMs: 10, cap: 10 });
    child.close(0);
    await run;
    // The child then inherits this process's environment, which is what the
    // option's default documents — `env: undefined` would hand it an empty one.
    expect(Object.hasOwn(child.call?.options ?? {}, "env")).toBe(false);
  });

  test("keeps the TAIL of each stream — the end is where a failure explains itself", async () => {
    const child = installChild();
    const run = runCapped("bash", [], { cwd: "/work", timeoutMs: 10, cap: 8 });
    child.emit("stdout", "0123456789");
    child.emit("stdout", "abcdef");
    child.emit("stderr", "boom, and then some more of it");
    child.close(0);
    const result = await run;
    // Capped on every append, so an earlier elision mark is itself part of
    // what the next cap counts — a tail is `cap` characters of output plus the
    // mark, never fewer than `cap`.
    expect(result.stdout).toBe("…89abcdef");
    expect(result.stderr).toBe("…re of it");
  });

  test("combineStreams interleaves stderr into stdout in ARRIVAL order", async () => {
    const child = installChild();
    const run = runCapped("bash", [], {
      cwd: "/work",
      timeoutMs: 10,
      cap: 100,
      combineStreams: true,
    });
    child.emit("stdout", "one\n");
    child.emit("stderr", "two\n");
    child.emit("stdout", "three\n");
    child.close(0);
    const result = await run;
    expect(result.stdout).toBe("one\ntwo\nthree\n");
    expect(result.stderr).toBe("");
  });

  test("a killed child RESOLVES with its signal", async () => {
    const child = installChild();
    const run = runCapped("bash", [], { cwd: "/work", timeoutMs: 10, cap: 100 });
    child.emit("stdout", "partial");
    child.close(null, "SIGTERM");
    // Resolving rather than rejecting is the decision: `bash` annotates the
    // kill onto its output where an npm install reports a failure, and both
    // read the same result.
    await expect(run).resolves.toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
      stdout: "partial",
    });
  });

  test("rejects only when the process could not be spawned at all", async () => {
    const child = installChild();
    const run = runCapped("nope", [], { cwd: "/work", timeoutMs: 10, cap: 10 });
    child.fail(new Error("spawn nope ENOENT"));
    await expect(run).rejects.toThrow(/ENOENT/);
  });
});

describe("keepTail", () => {
  test("marks the elision, so a truncated capture cannot read as the whole", () => {
    expect(keepTail("abcdef", 3)).toBe("…def");
    expect(keepTail("abc", 3)).toBe("abc");
    expect(keepTail("", 3)).toBe("");
  });
});

describe("outputWithKillNote", () => {
  const result = { exitCode: null, signal: null, stdout: "out", stderr: "" } as const;

  test("annotates a kill, because a killed command otherwise reads as a quiet one", () => {
    expect(outputWithKillNote({ ...result, signal: "SIGKILL" }, 250)).toBe(
      "out\n[killed by SIGKILL after 250ms]",
    );
  });

  test("leaves an ordinary result alone", () => {
    expect(outputWithKillNote(result, 250)).toBe("out");
  });
});
