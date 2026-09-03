// Copyright 2025 the AAI authors. MIT license.

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { fail, getOutputMode, installStdoutGuard, ok, stripAnsi, writeLine } from "./_output.ts";

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

  it("removes the JSON-escaped form, which is what a stringified result carries", () => {
    // The caller stringifies the whole result and hands the LINE over, by
    // which point `JSON.stringify` has turned the ESC byte into `\u001b`.
    const line = JSON.stringify({ ok: false, error: coloured });
    expect(stripAnsi(line)).not.toMatch(/u001[bB]\[/);
    expect(JSON.parse(stripAnsi(line))).toEqual({
      ok: false,
      error: '[MISSING_EXPORT] "default" is not exported.\n   ╭─[ agent.ts ]\n 1 │ im',
    });
  });

  it("leaves plain text alone", () => {
    expect(stripAnsi("No value provided for FOO")).toBe("No value provided for FOO");
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

  it("writes the line and resolves once flushed", async () => {
    const written = captureStdout();
    await writeLine('{"ok":true}\n');
    expect(written).toEqual(['{"ok":true}\n']);
  });

  it("strips ANSI on the way out, so the envelope is machine-readable", async () => {
    const written = captureStdout();
    await writeLine(`${JSON.stringify({ ok: false, error: "\u001B[31mboom\u001B[0m" })}\n`);
    expect(written[0]).toBe('{"ok":false,"error":"boom"}\n');
  });
});
