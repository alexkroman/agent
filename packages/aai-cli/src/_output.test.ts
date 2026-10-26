// Copyright 2025 the AAI authors. MIT license.

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  fail,
  getOutputMode,
  installStdoutGuard,
  ok,
  oweExitCode,
  resultLine,
  sanitizeTerminalText,
  stripAnsi,
  writeLine,
} from "./_output.ts";

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
  // A stub that THROWS rather than one cast to `never`: `process.exit` is typed
  // `never` and a body that only throws is inferred that way, so no cast is
  // needed — and nothing in the guard runs after the exit call, so the throw
  // (out of the synchronous `emit`) is the only thing it changes.
  function stubExit() {
    return vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });
  }

  // A flat `exit(0)` on EPIPE turned a failing `aai list | <closed>` into a
  // success under `pipefail`; the guard exits with what the run OWES.
  it.each([
    [0, 0],
    [1, 1],
    [undefined, 1],
  ])("exits quietly on EPIPE with the owed code (owed %s → %s)", (owed, expected) => {
    const exitSpy = stubExit();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stream = new EventEmitter();
    installStdoutGuard(stream);
    oweExitCode(owed);

    const err = new Error("broken pipe") as NodeJS.ErrnoException;
    err.code = "EPIPE";
    expect(() => stream.emit("error", err)).toThrow(`process.exit(${expected})`);

    expect(exitSpy).toHaveBeenCalledWith(expected);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("reports other stream errors on stderr and exits 1", () => {
    const exitSpy = stubExit();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stream = new EventEmitter();
    installStdoutGuard(stream);

    expect(() => stream.emit("error", new Error("disk full"))).toThrow("process.exit(1)");

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

/**
 * A bundler colours its diagnostics whether or not anything is watching, so
 * `aai build`'s failure reached the JSON envelope studded with per-character
 * SGR pairs — illegible in a CI log and meaningless to the `jq` consumer that
 * JSON mode exists for. The escapes are stripped at the one place every
 * envelope goes out through, so no module has to remember to.
 */
describe("stripAnsi", () => {
  // The real shape, from `aai build` against an agent.ts with no default
  // export: an SGR pair around the code, then one pair PER CHARACTER of the
  // source frame.
  const coloured =
    '\u001B[31m[MISSING_EXPORT] \u001B[0m"default" is not exported.\n' +
    "   \u001B[38;5;246m╭\u001B[0m─[ agent.ts ]\n" +
    " \u001B[38;5;246m1 │\u001B[0m \u001B[38;5;249mi\u001B[0m\u001B[38;5;249mm\u001B[0m";

  it("removes SGR pairs, including 256-colour ones, and keeps the text", () => {
    expect(stripAnsi(coloured)).toBe(
      '[MISSING_EXPORT] "default" is not exported.\n   ╭─[ agent.ts ]\n 1 │ im',
    );
  });

  it("leaves plain text alone", () => {
    expect(stripAnsi("No value provided for FOO")).toBe("No value provided for FOO");
  });
});

/**
 * Server- and agent-supplied text reached the terminal raw: a project name in
 * `aai list`, an error body, a log line. Each escape below is one the
 * adversarial run delivered through such a field.
 */
describe("sanitizeTerminalText", () => {
  const safe = (text: string) => sanitizeTerminalText(text, { keepSgr: true });

  it.each([
    ["an OSC 52 clipboard write (BEL-terminated)", "a\u001B]52;c;ZXZpbA==\u0007b", "ab"],
    ["an OSC 0 window title (ST-terminated)", "a\u001B]0;pwned\u001B\\b", "ab"],
    ["an OSC 8 hyperlink", "\u001B]8;;https://evil.test\u001B\\click\u001B]8;;\u001B\\", "click"],
    ["a screen clear", "a\u001B[2Jb", "ab"],
    ["a cursor move", "a\u001B[10;1Hb", "ab"],
    ["a full terminal reset", "a\u001Bcb", "ab"],
    ["a charset select", "a\u001B(Bb", "ab"],
    ["a DCS string", "a\u001BPq#0\u001B\\b", "ab"],
    ["an unterminated OSC, to the end", "a\u001B]52;c;Zm9v", "a"],
  ])("removes %s", (_name, input, expected) => {
    expect(safe(input)).toBe(expected);
  });

  it("keeps SGR colour when asked, and drops it when not", () => {
    expect(safe("\u001B[31mred\u001B[0m")).toBe("\u001B[31mred\u001B[0m");
    expect(sanitizeTerminalText("\u001B[31mred\u001B[0m", { keepSgr: false })).toBe("red");
  });

  it("renders other control characters visibly, keeping \\n and \\t", () => {
    expect(safe("bell\u0007 nul\u0000 bs\u0008 csi\u009B del\u007F")).toBe(
      "bell\\x07 nul\\x00 bs\\x08 csi\\x9b del\\x7f",
    );
    expect(safe("a\tb\nc\r\nd\re")).toBe("a\tb\nc\nd\\x0de");
    // A lone ESC that starts no sequence is a stray byte, not silence.
    expect(safe("end\u001B")).toBe("end\\x1b");
  });

  it("returns the same string when there is nothing to do", () => {
    const plain = "żółć 日本 🎤";
    expect(safe(plain)).toBe(plain);
  });
});

describe("resultLine", () => {
  it("keeps DATA verbatim, escape bytes included", () => {
    // `aai init $'\e[31mred'` reported `dir: ".../red"` while creating a
    // directory whose name holds the ESC byte; a consumer acting on the
    // reported path acted on a different one.
    const dir = "/tmp/\u001B[31mred\u001B[0m";
    const parsed = JSON.parse(resultLine(ok({ dir }))) as { data: { dir: string } };
    expect(parsed.data.dir).toBe(dir);
  });

  it("strips every escape from the human-text fields, OSC included", () => {
    const line = resultLine(
      fail("x", "\u001B[31mboom\u001B[0m\u001B]52;c;ZXZpbA==\u0007", "\u001B[2Jhint"),
    );
    expect(JSON.parse(line)).toEqual({ ok: false, code: "x", error: "boom", hint: "hint" });
    expect(line.endsWith("}\n")).toBe(true);
  });

  it("cleans string warnings and nothing else in an ok result", () => {
    const parsed = JSON.parse(
      resultLine(ok({ name: "\u001B]0;t\u0007n", warnings: ["\u001B[33mw\u001B[0m"] })),
    ) as { data: { name: string; warnings: string[] } };
    expect(parsed.data).toEqual({ name: "\u001B]0;t\u0007n", warnings: ["w"] });
  });
});

describe("writeLine", () => {
  /**
   * Capture what reaches stdout. No teardown: `restoreMocks` restores every
   * `vi.spyOn` before each test, so a `mockRestore()` here would be dead.
   */
  function captureStdout(): string[] {
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown, cb?: unknown) => {
      written.push(String(chunk));
      if (typeof cb === "function") cb();
      return true;
    });
    return written;
  }

  it("writes the line verbatim and resolves once flushed", async () => {
    const written = captureStdout();
    const line = `${JSON.stringify({ ok: true, data: { dir: "\u001B[31m" } })}\n`;
    await writeLine(line);
    expect(written).toEqual([line]);
  });
});
