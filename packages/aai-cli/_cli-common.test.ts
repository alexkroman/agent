// Copyright 2026 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CliError, ok } from "./_output.ts";
import { withTempDir } from "./_test-utils.ts";

const logMock = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  message: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  step: vi.fn(),
}));
const silenceOutput = vi.hoisted(() => vi.fn());
vi.mock("./_ui.ts", () => ({ log: logMock, silenceOutput }));

const { runCommand, setup, sharedArgs } = await import("./_cli-common.ts");

describe("setup", () => {
  test("resolves the cwd; requires agent.ts only when asked", async () => {
    await withTempDir(async (dir) => {
      vi.stubEnv("INIT_CWD", dir);
      // No agent.ts: plain setup passes, agent-gated setup refuses.
      expect(await setup()).toBe(dir);
      await expect(setup({ agent: true })).rejects.toThrow("No agent.ts found");
      await fs.writeFile(path.join(dir, "agent.ts"), "export {};");
      expect(await setup({ agent: true })).toBe(dir);
    });
  });
});

describe("runCommand", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((_chunk, cb?: unknown) => {
      if (typeof cb === "function") (cb as () => void)();
      return true;
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  test("human mode: success runs the body without exiting", async () => {
    const body = vi.fn().mockResolvedValue(ok({ fine: true }));
    await runCommand({ json: false }, body);
    expect(body).toHaveBeenCalledWith("human");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(silenceOutput).not.toHaveBeenCalled();
  });

  test("human mode: a thrown CliError logs the message AND the hint, exits 1", async () => {
    await runCommand({ json: false }, async () => {
      throw new CliError("bad_thing", "It broke", "Try the other thing");
    });
    expect(logMock.error).toHaveBeenCalledWith("It broke");
    // The hint is the recovery step — it must reach the terminal.
    expect(logMock.info).toHaveBeenCalledWith("Try the other thing");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("human mode: a plain Error gets the generic failure code", async () => {
    await runCommand({ json: false }, async () => {
      throw new Error("boom");
    });
    expect(logMock.error).toHaveBeenCalledWith("boom");
    expect(logMock.info).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("json mode: silences logs and writes exactly one result line", async () => {
    await runCommand({ json: true }, async () => ok({ n: 1 }));
    expect(silenceOutput).toHaveBeenCalled();
    const written = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(JSON.parse(written.trim())).toEqual({ ok: true, data: { n: 1 } });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test("json mode: a failure becomes a machine-readable line and exit 1", async () => {
    await runCommand({ json: true }, async () => {
      throw new CliError("no_input", "Nothing here", "Pipe something in");
    });
    const written = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(JSON.parse(written.trim())).toEqual({
      ok: false,
      code: "no_input",
      error: "Nothing here",
      hint: "Pipe something in",
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("sharedArgs", () => {
  test("declares the flags every platform command shares", () => {
    expect(Object.keys(sharedArgs).sort()).toEqual(["json", "server", "yes"]);
  });
});
