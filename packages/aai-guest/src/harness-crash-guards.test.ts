// Copyright 2026 the AAI authors. MIT license.
// The crash guards' contract is asymmetric on purpose: a stray rejection is
// logged and swallowed (one bad turn must not kill every live session in the
// sandbox), while an uncaught exception exits so the host replaces the guest.

import { beforeEach, describe, expect, test, vi } from "vitest";
import { stubProcessExit } from "./_test-utils.ts";
import { installCrashGuards } from "./harness-crash-guards.ts";

type Handler = (reason: unknown) => void;

let handlers: Map<string, Handler>;

beforeEach(() => {
  // Capture the listeners without registering them on the real process —
  // a real uncaughtException listener would swallow vitest's own failures.
  handlers = new Map();
  vi.spyOn(process, "on").mockImplementation(((event: string, handler: Handler) => {
    handlers.set(event, handler);
    return process;
  }) as never);
  installCrashGuards();
});

describe("installCrashGuards", () => {
  test("registers both guards", () => {
    expect([...handlers.keys()].sort()).toEqual(["uncaughtException", "unhandledRejection"]);
  });

  test("an unhandled rejection is logged and swallowed — the process survives", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = stubProcessExit();

    handlers.get("unhandledRejection")?.(new Error("UND_ERR_BODY_TIMEOUT"));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("unhandled rejection (session continues): UND_ERR_BODY_TIMEOUT"),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test("a non-Error rejection reason still logs a message", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    handlers.get("unhandledRejection")?.("string reason");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("string reason"));
  });

  test("an uncaught exception logs and exits 4 so the host replaces the guest", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = stubProcessExit();

    handlers.get("uncaughtException")?.(new Error("torn state"));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("uncaught exception; exiting: torn state"),
    );
    expect(exitSpy).toHaveBeenCalledWith(4);
  });
});

/**
 * The measured production case: deleting a studio project drops the app
 * database's role, terminating its backends, and graphile-worker's `pg` pool
 * raised that as an EventEmitter `error` with no listener. The guest exited —
 * taking every live voice session on the sandbox with it, none of which had
 * anything to do with the deleted project.
 *
 * A SQLSTATE, not a message, is what these assert on: the sentence beside it is
 * localized and reworded between releases, and matching it is how a guard like
 * this quietly stops matching.
 */
describe("a database connection that went away", () => {
  /** The shape `pg` throws: an `Error` carrying a SQLSTATE on `code`. */
  function pgError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
  }

  test("is logged and swallowed, so live sessions survive a project delete", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = stubProcessExit();

    handlers.get("uncaughtException")?.(
      pgError("57P01", "terminating connection due to administrator command"),
    );

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("database connection lost (57P01); sessions continue"),
    );
    // Never the framing that reads as our bug — the database going away is a
    // thing the platform does on purpose.
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("uncaught exception"));
  });

  test.each([
    ["08006", "connection_failure"],
    ["08003", "connection_does_not_exist"],
    ["57P02", "crash_shutdown"],
    ["57P03", "cannot_connect_now"],
  ])("survives %s (%s)", (code, message) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = stubProcessExit();

    handlers.get("uncaughtException")?.(pgError(code, message));

    expect(exitSpy).not.toHaveBeenCalled();
  });

  test("is recognized through one level of `cause` wrapping, as a pool checkout wraps it", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = stubProcessExit();

    const wrapped = new Error("could not check out a client", {
      cause: pgError("57P01", "terminating connection due to administrator command"),
    });
    handlers.get("uncaughtException")?.(wrapped);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  /**
   * The other half, and the one that keeps the exception guard meaningful: a
   * database error that is NOT about the connection still exits. Without this a
   * widened classifier could swallow every `pg` fault and nothing would notice.
   */
  test.each([
    ["57014", "query_canceled — a statement timeout says nothing about the link"],
    ["23505", "unique_violation"],
    ["42601", "syntax_error"],
  ])("still exits on %s", (code, message) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = stubProcessExit();

    handlers.get("uncaughtException")?.(pgError(code, message));

    expect(exitSpy).toHaveBeenCalledWith(4);
  });

  test("still exits on an ordinary error that carries no code at all", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = stubProcessExit();

    handlers.get("uncaughtException")?.(new Error("torn state"));

    expect(exitSpy).toHaveBeenCalledWith(4);
  });

  /**
   * A cyclic `cause` must not blow the stack INSIDE the handler that is the last
   * thing left to report a crash. Both shapes, because a self-reference check
   * passes the first and loops forever on the second — which is the one a real
   * wrap-and-rethrow chain produces.
   */
  test.each([
    ["self-referential", true],
    ["two-link", false],
  ])("does not loop forever on a %s cause cycle", (_name, selfRef) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = stubProcessExit();

    const a: Error & { cause?: unknown } = new Error("a");
    if (selfRef) {
      a.cause = a;
    } else {
      const b: Error & { cause?: unknown } = new Error("b");
      a.cause = b;
      b.cause = a;
    }
    expect(() => handlers.get("uncaughtException")?.(a)).not.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(4);
  });
});
