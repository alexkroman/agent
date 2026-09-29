// Copyright 2026 the AAI authors. MIT license.
// The zero-permission Deno executor, over an injected spawner: what argv and
// env the child gets, and how an answer, a failure, the deadline and the output
// cap come back. `_run-code-deno.scenario.test.ts` runs the real binary.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  createDenoRunCode,
  DENO_RUN_CODE_STDOUT_CAP_BYTES,
  type DenoProbe,
  denoRunCodeArgs,
  denoRunCodeEnv,
  type RunCodeChild,
  type RunCodeSpawn,
  resolveDenoRunCode,
} from "./_run-code-deno.ts";

/** A child the test drives: it hears stdin, and answers when told to. */
class FakeChild extends EventEmitter implements RunCodeChild {
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  stdinText = "";
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.stdinText += chunk.toString();
    });
  }
  kill(): boolean {
    return true;
  }
  finish(code: number | null, out = "", err = "", signal: NodeJS.Signals | null = null): void {
    this.stdout.end(out);
    this.stderr.end(err);
    this.exitCode = code;
    this.signalCode = signal;
    setImmediate(() => this.emit("close", code, signal));
  }
}

function harness(answer?: (child: FakeChild) => void) {
  const child = new FakeChild();
  const spawn = vi.fn<RunCodeSpawn>(() => {
    if (answer) child.stdin.on("finish", () => answer(child));
    return child;
  });
  const kill = vi.fn((_child: RunCodeChild) => undefined);
  return { child, spawn, kill };
}

const CODE = 'console.log("--allow-all"); Deno.exit(0)';

describe("createDenoRunCode", () => {
  test("the code goes on stdin only: argv is fixed, and the env is the minimal one", async () => {
    const { child, spawn, kill } = harness((c) => c.finish(0, "2\n"));
    const run = createDenoRunCode({ deno: "/opt/deno", spawn, kill });
    expect(await run(CODE)).toBe("2");
    const [command, args, options] = spawn.mock.calls[0] ?? [];
    expect(command).toBe("/opt/deno");
    expect(args).toEqual(denoRunCodeArgs());
    expect(args?.join(" ")).not.toContain("allow");
    expect(args?.at(-1)).toBe("-");
    expect(args).toContain("--no-prompt");
    expect(options?.env).toEqual(denoRunCodeEnv());
    expect(Object.keys(options?.env ?? {}).sort()).toEqual([
      "DENO_DIR",
      "DENO_NO_UPDATE_CHECK",
      "NO_COLOR",
    ]);
    expect(options?.detached).toBe(true);
    expect(child.stdinText).toBe(CODE);
  });

  test("no output reads as the guest's sentence, and stderr is part of the output", async () => {
    const quiet = harness((c) => c.finish(0));
    expect(await createDenoRunCode({ deno: "d", ...quiet })("1")).toBe(
      "Code ran successfully (no output)",
    );
    const both = harness((c) => c.finish(0, "out\n", "warned\n"));
    expect(await createDenoRunCode({ deno: "d", ...both })("1")).toBe("out\nwarned");
  });

  test("an uncaught error is the error line without Deno's prefixes", async () => {
    const stderr =
      'error: Uncaught (in promise) NotCapable: Requires net access to "example.com:443"\n' +
      "    at file:///$deno$stdin.mts:1:7\n";
    const { spawn, kill } = harness((c) => c.finish(1, "", stderr));
    expect(await createDenoRunCode({ deno: "d", spawn, kill })("x")).toEqual({
      error: 'NotCapable: Requires net access to "example.com:443"',
    });
  });

  test("a non-zero exit with nothing said, and an OOM, are errors too", async () => {
    const exit = harness((c) => c.finish(3));
    expect(await createDenoRunCode({ deno: "d", ...exit })("x")).toEqual({
      error: "run_code exited with code 3",
    });
    const oom = harness((c) => c.finish(null, "", "<--- Last few GCs --->", "SIGTRAP"));
    expect(await createDenoRunCode({ deno: "d", ...oom })("x")).toEqual({
      error: expect.stringContaining("ran out of memory"),
    });
  });

  test("the deadline kills the process and answers an error", async () => {
    const { spawn, kill, child } = harness();
    const result = await createDenoRunCode({ deno: "d", spawn, kill, timeoutMs: 20 })(
      "while(true){}",
    );
    expect(result).toEqual({ error: "run_code timed out after 20ms" });
    expect(kill).toHaveBeenCalledWith(child);
  });

  test("output past the cap is cut, and the process is killed when it fills", async () => {
    const { spawn, kill, child } = harness((c) => {
      c.stdout.write(Buffer.alloc(DENO_RUN_CODE_STDOUT_CAP_BYTES + 100, "x"));
      c.finish(null, "", "", "SIGKILL");
    });
    const result = await createDenoRunCode({ deno: "d", spawn, kill })("for(;;)console.log(1)");
    expect(typeof result).toBe("string");
    expect(String(result)).toContain(`output cut at ${DENO_RUN_CODE_STDOUT_CAP_BYTES} bytes`);
    expect(String(result).match(/x/g)?.length).toBe(DENO_RUN_CODE_STDOUT_CAP_BYTES);
    expect(kill).toHaveBeenCalledWith(child);
  });
});

describe("resolveDenoRunCode", () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  const ok: DenoProbe = () => ({ version: "2.9.5" });

  test("unset: no executor and nothing said — run_code refuses as before", () => {
    const log = logger();
    expect(resolveDenoRunCode(log, {}, ok)).toBeUndefined();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("deno with a binary: an executor and one boot line naming it", () => {
    const log = logger();
    const run = resolveDenoRunCode(
      log,
      { AAI_RUN_CODE: "deno", AAI_DENO_PATH: "/opt/deno/bin/deno" },
      ok,
    );
    expect(run).toBeTypeOf("function");
    expect(log.info).toHaveBeenCalledWith("run_code runs in a zero-permission Deno sandbox", {
      deno: "/opt/deno/bin/deno",
      version: "2.9.5",
      timeoutMs: 5000,
    });
  });

  test("enabled but unusable: a warning, and still no executor", () => {
    for (const [env, probe] of [
      [{ AAI_RUN_CODE: "deno", PATH: "" }, ok],
      [{ AAI_RUN_CODE: "deno", AAI_DENO_PATH: "/x/deno" }, () => ({ problem: "too old" })],
      [{ AAI_RUN_CODE: "node" }, ok],
    ] as const) {
      const log = logger();
      expect.soft(resolveDenoRunCode(log, env, probe)).toBeUndefined();
      expect.soft(log.warn).toHaveBeenCalledOnce();
    }
  });
});
