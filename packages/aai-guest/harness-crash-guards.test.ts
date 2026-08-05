// Copyright 2026 the AAI authors. MIT license.
// The crash guards' contract is asymmetric on purpose: a stray rejection is
// logged and swallowed (one bad turn must not kill every live session in the
// sandbox), while an uncaught exception exits so the host replaces the guest.

import { beforeEach, describe, expect, test, vi } from "vitest";
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
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

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
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    handlers.get("uncaughtException")?.(new Error("torn state"));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("uncaught exception; exiting: torn state"),
    );
    expect(exitSpy).toHaveBeenCalledWith(4);
  });
});
