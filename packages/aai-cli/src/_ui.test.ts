// Copyright 2025 the AAI authors. MIT license.
import * as clack from "@clack/prompts";
import { describe, expect, test, vi } from "vitest";
import { CANCEL, createFakeUi, stubProcessExit } from "./_test-utils.ts";
import { createUi, parsePort, type UiTerm, unwrapCancel } from "./_ui.ts";

describe("parsePort", () => {
  test("parses valid port", () => {
    expect(parsePort("3000")).toBe(3000);
  });

  // `Number()` read `0x10` as 16 and `1e3` as 1000 — a port the user never
  // typed, bound without a word. No command documents 0 ("any free port").
  test.each(["0", "0x10", "1e3", "3000.0", "+3000", " 3000", "", "  ", "0b11", "Infinity"])(
    "refuses %j",
    (raw) => {
      expect(() => parsePort(raw)).toThrow(`Invalid port: ${raw}`);
    },
  );

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

/**
 * The seam is where server- and agent-supplied text is made terminal-safe, so
 * no call site has to remember: `aai list` names, error bodies, `aai logs`
 * lines, workflow names all go out through these paths.
 */
describe("createUi: escape sequences never reach the terminal raw", () => {
  const HOSTILE = "name\u001B]52;c;ZXZpbA==\u0007\u001B[2J\u001B]0;title\u0007";

  test("log keeps colour and drops the rest", () => {
    const spy = vi.spyOn(clack.log, "message").mockImplementation(() => undefined);
    createUi().log.message(`\u001B[36m${HOSTILE}\u001B[39m`);
    expect(spy).toHaveBeenCalledWith("\u001B[36mname\u001B[39m");
  });

  test("a silenced notify (plain stderr) and writeErr are cleaned too", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const ui = createUi();
    ui.silence();
    ui.notify("error", HOSTILE);
    ui.writeErr(`bell\u0007${HOSTILE}`);
    expect(stderr.mock.calls.map(([chunk]) => chunk)).toEqual(["name\n", "bell\\x07name\n"]);
  });

  test("prompt messages, select labels and hints, and spinner text", async () => {
    const select = vi.fn(async () => "a");
    const confirm = vi.fn(async () => true);
    const start = vi.fn();
    const stop = vi.fn();
    const term = {
      ...clack,
      select,
      confirm,
      spinner: () => ({ start, stop }),
    } as UiTerm;
    const ui = createUi(term);
    await ui.prompts.confirm({ message: HOSTILE });
    await ui.prompts.select({
      message: HOSTILE,
      options: [{ value: "a", label: HOSTILE, hint: HOSTILE }],
    });
    const spinner = ui.prompts.spinner();
    spinner.start(HOSTILE);
    spinner.stop(HOSTILE);
    expect(confirm).toHaveBeenCalledWith({ message: "name" });
    expect(select).toHaveBeenCalledWith({
      message: "name",
      options: [{ value: "a", label: "name", hint: "name" }],
    });
    expect(start).toHaveBeenCalledWith("name");
    expect(stop).toHaveBeenCalledWith("name");
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
