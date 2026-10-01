// Copyright 2025 the AAI authors. MIT license.
import * as clack from "@clack/prompts";
import { describe, expect, test, vi } from "vitest";
import { CANCEL, createFakeUi, stubProcessExit } from "./_test-utils.ts";
import { createUi, parsePort, unwrapCancel } from "./_ui.ts";

describe("parsePort", () => {
  test("parses valid port", () => {
    expect(parsePort("3000")).toBe(3000);
  });

  test("parses port 0", () => {
    expect(parsePort("0")).toBe(0);
  });

  test("parses port 65535", () => {
    expect(parsePort("65535")).toBe(65_535);
  });

  test("throws on non-numeric input", () => {
    expect(() => parsePort("abc")).toThrow("Invalid port: abc");
  });

  test("throws on port above 65535", () => {
    expect(() => parsePort("70000")).toThrow("Invalid port: 70000");
  });

  test("throws on negative port", () => {
    expect(() => parsePort("-1")).toThrow("Invalid port: -1");
  });
});

// Each spec builds its own `createUi()`: silencing is per-instance state, so no
// spec observes another's JSON mode whatever the order.
describe("createUi: notify before silence()", () => {
  test("delegates to the styled log in human mode", () => {
    const spy = vi.spyOn(clack.log, "error").mockImplementation(() => undefined);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    createUi().notify("error", "boom");
    expect(spy).toHaveBeenCalledWith("boom");
    // Human mode must not double-report by also writing the raw line.
    expect(stderr).not.toHaveBeenCalled();
  });
});

describe("createUi: silence()", () => {
  test("no-ops every log method", () => {
    const spies = (["info", "success", "error", "warn", "step", "message"] as const).map((m) =>
      vi.spyOn(clack.log, m).mockImplementation(() => undefined),
    );
    const ui = createUi();
    ui.silence();
    expect(ui.silenced).toBe(true);
    for (const m of ["info", "success", "error", "warn", "step", "message"] as const) {
      ui.log[m]("test");
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * The reason `notify` exists: JSON mode is auto-detected on a pipe, and
 * `silence()` no-ops every `log` method for the rest of the process. That is
 * correct for a request/response command (stdout carries exactly one JSON
 * line) and wrong for a long-running one — a piped `aai dev` silenced every
 * later rebuild failure. stderr keeps the stdout contract while still
 * reporting.
 */
describe("createUi: notify after silence()", () => {
  test("writes to stderr instead of vanishing, at every level", () => {
    const ui = createUi();
    ui.silence();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    for (const level of ["error", "warn", "info", "success"] as const) {
      ui.notify(level, `msg-${level}`);
      expect(stderr).toHaveBeenCalledWith(`msg-${level}\n`);
    }
  });
});

describe("unwrapCancel", () => {
  test("passes an answer through", () => {
    expect(unwrapCancel(createFakeUi(), "pizza")).toBe("pizza");
  });

  test("a cancelled prompt names what was cancelled and exits 0", () => {
    const ui = createFakeUi();
    const exit = stubProcessExit();
    unwrapCancel(ui, CANCEL, "Setup cancelled");
    expect(ui.prompts.cancel).toHaveBeenCalledWith("Setup cancelled");
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe("createFakeUi", () => {
  test("records by level, and a silenced log records nothing but notify's stderr", () => {
    const ui = createFakeUi();
    ui.log.info("one");
    ui.notify("warn", "two");
    expect(ui.said("info")).toEqual(["one"]);
    expect(ui.said("warn")).toEqual(["two"]);
    ui.silence();
    ui.log.error("dropped");
    ui.notify("error", "kept");
    expect(ui.all()).toEqual(["one", "two"]);
    expect(ui.stderr).toEqual(["kept"]);
  });

  test("an unscripted prompt rejects naming itself rather than hanging", async () => {
    await expect(createFakeUi().prompts.password({ message: "x" })).rejects.toThrow(
      /unexpected password prompt/,
    );
  });
});
