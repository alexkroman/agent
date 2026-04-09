// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, it, vi } from "vitest";
import { fail, getOutputMode, ok, withOutput } from "./_output.ts";

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

describe("withOutput", () => {
  it("writes JSON to stdout in json mode", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const humanRender = vi.fn();

    await withOutput("json", async () => ok({ slug: "test-abc" }), humanRender);

    expect(writeSpy).toHaveBeenCalledWith('{"ok":true,"data":{"slug":"test-abc"}}\n');
    expect(humanRender).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it("calls humanRender in human mode", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const humanRender = vi.fn();
    const result = ok({ slug: "test-abc" });

    await withOutput("human", async () => result, humanRender);

    expect(humanRender).toHaveBeenCalledWith(result);
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it("writes JSON error and exits 1 in json mode on failure", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const humanRender = vi.fn();

    await withOutput("json", async () => fail("not_found", "Agent not found"), humanRender);

    expect(writeSpy).toHaveBeenCalledWith(
      '{"ok":false,"error":"Agent not found","code":"not_found"}\n',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    writeSpy.mockRestore();
    exitSpy.mockRestore();
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
