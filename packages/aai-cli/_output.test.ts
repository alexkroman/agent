// Copyright 2025 the AAI authors. MIT license.

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { fail, getOutputMode, installStdoutGuard, ok } from "./_output.ts";

describe("getOutputMode", () => {
  it("returns json when --json flag is true", () => {
    expect(getOutputMode({ json: true }, true)).toBe("json");
  });

  it("returns human when --json flag is false (--no-json)", () => {
    expect(getOutputMode({ json: false }, false)).toBe("human");
  });

  it("returns json when no flag and non-TTY", () => {
    expect(getOutputMode({}, false)).toBe("json");
  });

  it("returns human when no flag and TTY", () => {
    expect(getOutputMode({}, true)).toBe("human");
  });

  it("--json overrides TTY detection", () => {
    expect(getOutputMode({ json: true }, true)).toBe("json");
  });

  it("--no-json overrides non-TTY detection", () => {
    expect(getOutputMode({ json: false }, false)).toBe("human");
  });
});

describe("installStdoutGuard", () => {
  function makeStream(): NodeJS.WriteStream {
    return new EventEmitter() as unknown as NodeJS.WriteStream;
  }

  it("exits 0 quietly on EPIPE (consumer closed the pipe)", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stream = makeStream();
    installStdoutGuard(stream);

    const err = new Error("broken pipe") as NodeJS.ErrnoException;
    err.code = "EPIPE";
    stream.emit("error", err);

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("reports other stream errors on stderr and exits 1", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stream = makeStream();
    installStdoutGuard(stream);

    stream.emit("error", new Error("disk full"));

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith("stdout error: disk full\n");
  });
});

describe("ok / fail helpers", () => {
  it("ok wraps data", () => {
    expect(ok({ x: 1 })).toEqual({ ok: true, data: { x: 1 } });
  });

  it("fail creates error without hint", () => {
    expect(fail("auth_failed", "No key")).toEqual({
      ok: false,
      error: "No key",
      code: "auth_failed",
    });
  });

  it("fail creates error with hint", () => {
    expect(fail("auth_failed", "No key", "Set env var")).toEqual({
      ok: false,
      error: "No key",
      code: "auth_failed",
      hint: "Set env var",
    });
  });
});
