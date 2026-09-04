// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { parsePort } from "./_ui.ts";

/**
 * A FRESH copy of `_ui.ts`, never silenced.
 *
 * `silenceOutput()` sets irreversible module state, so which describe below
 * observes the un-silenced path used to be decided by declaration order — a
 * comment saying "declare this first", true of the current file and silently
 * false under `sequence.shuffle` or a reordering edit. Re-importing makes the
 * precondition structural instead: each test states which state it wants.
 */
async function freshUi(): Promise<typeof import("./_ui.ts")> {
  vi.resetModules();
  return await import("./_ui.ts");
}

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

describe("notify (before silenceOutput)", () => {
  test("delegates to the styled log in human mode", async () => {
    const { log, notify } = await freshUi();
    const spy = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    notify("error", "boom");
    expect(spy).toHaveBeenCalledWith("boom");
    // Human mode must not double-report by also writing the raw line.
    expect(stderr).not.toHaveBeenCalled();
  });
});

describe("silenceOutput", () => {
  test("replaces log methods with no-ops after silenceOutput()", async () => {
    const { log, silenceOutput } = await freshUi();
    silenceOutput();
    // Should not throw — all methods are now no-ops
    expect(() => log.info("test")).not.toThrow();
    expect(() => log.success("test")).not.toThrow();
    expect(() => log.error("test")).not.toThrow();
    expect(() => log.warn("test")).not.toThrow();
    expect(() => log.step("test")).not.toThrow();
    expect(() => log.message("test")).not.toThrow();
  });
});

/**
 * The reason `notify` exists: JSON mode is auto-detected on a pipe, and
 * `silenceOutput` no-ops every `log` method for the rest of the process. That
 * is correct for a request/response command (stdout carries exactly one JSON
 * line) and wrong for a long-running one — a piped `aai dev` silenced every
 * later rebuild failure, so edits stopped taking effect with nothing said.
 * stderr keeps the stdout contract while still reporting.
 */
describe("notify (after silenceOutput)", () => {
  test("writes to stderr instead of vanishing", async () => {
    const { notify, silenceOutput } = await freshUi();
    silenceOutput();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    notify("error", "Restart failed: boom");
    expect(stderr).toHaveBeenCalledWith("Restart failed: boom\n");
  });

  test("reports every level, so a rebuild notice is not lost either", async () => {
    const { notify, silenceOutput } = await freshUi();
    silenceOutput();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    for (const level of ["error", "warn", "info", "success"] as const) {
      notify(level, `msg-${level}`);
      expect(stderr).toHaveBeenCalledWith(`msg-${level}\n`);
    }
  });
});
