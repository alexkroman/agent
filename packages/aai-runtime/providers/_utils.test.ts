// Copyright 2026 the AAI authors. MIT license.

import { omitUndefined } from "@alexkroman1/aai/utils";
import { createNanoEvents } from "nanoevents";
import { describe, expect, it } from "vitest";
import { createSessionShell } from "./_utils.ts";

type ShellEvents = { error: (err: Error) => void; note: (text: string) => void };

/** Collect the messages a shell surfaces, with a no-op teardown. */
function makeShell(cleanCloseIsFatal?: boolean) {
  const errors: string[] = [];
  const emitter = createNanoEvents<ShellEvents>();
  emitter.on("error", (err) => errors.push(err.message));
  const shell = createSessionShell({
    emitter,
    makeStreamError: (message) => new Error(message),
    emitError: (err) => emitter.emit("error", err),
    teardown: () => {
      // No connection to release; these tests exercise close semantics only.
    },
    ...omitUndefined({ cleanCloseIsFatal }),
  });
  return { shell, errors, emitter };
}

describe("createSessionShell emit", () => {
  it("contains a listener throw instead of letting it escape the socket handler", () => {
    // These fire from inside a raw `ws.on("message")`, where a throw escapes
    // into Node's EventEmitter as an uncaughtException — taking down a
    // multi-tenant host rather than one session. Five sites emitted around the
    // shell, and `safeEmit` was applied in two openers of seven, which is why
    // the emitter is the shell's now.
    const { shell } = makeShell();
    shell.on("note", () => {
      throw new Error("listener blew up");
    });
    expect(() => shell.emit("note", "hello")).not.toThrow();
  });

  it("delivers to every listener and returns an unsubscribe", () => {
    const { shell } = makeShell();
    const seen: string[] = [];
    const off = shell.on("note", (text) => seen.push(text));
    shell.emit("note", "one");
    off();
    shell.emit("note", "two");
    expect(seen).toEqual(["one"]);
  });

  it("emits nothing once the session is closed", async () => {
    const { shell } = makeShell();
    const seen: string[] = [];
    shell.on("note", (text) => seen.push(text));
    await shell.close();
    shell.emit("note", "after close");
    expect(seen).toEqual([]);
  });

  it("contains a listener throw on the error path too", () => {
    const { shell } = makeShell();
    shell.on("error", () => {
      throw new Error("error listener blew up");
    });
    expect(() => shell.streamError("boom")).not.toThrow();
  });
});

describe("createSessionShell close handling", () => {
  it.each([undefined, false, true])(
    "surfaces abnormal close codes regardless of the flag (%s)",
    (flag) => {
      const { shell, errors } = makeShell(flag);
      shell.onSocketClose(1006);
      expect(errors).toEqual(["socket closed 1006"]);
    },
  );

  it("ignores a clean close by default, so a finished output stream is not an error", () => {
    const { shell, errors } = makeShell();
    shell.onSocketClose(1000);
    expect(errors).toEqual([]);
  });

  it("ignores an absent close code by default", () => {
    const { shell, errors } = makeShell();
    shell.onSocketClose(undefined);
    expect(errors).toEqual([]);
  });

  describe("cleanCloseIsFatal", () => {
    it("surfaces a provider's clean close, which would otherwise go unreported", () => {
      const { shell, errors } = makeShell(true);
      shell.onSocketClose(1000);
      expect(errors).toEqual(["socket closed 1000"]);
    });

    it("surfaces an absent close code", () => {
      const { shell, errors } = makeShell(true);
      shell.onSocketClose(undefined);
      expect(errors).toEqual(["socket closed unknown"]);
    });

    it("stays silent for a close we initiated ourselves", async () => {
      // The latch, not the close code, distinguishes our intent: teardown
      // triggers the socket's close event, which must not look like a failure.
      const { shell, errors } = makeShell(true);
      await shell.close();
      shell.onSocketClose(1000);
      expect(errors).toEqual([]);
    });

    it("stays silent for an abnormal close after we initiated teardown", async () => {
      const { shell, errors } = makeShell(true);
      await shell.close();
      shell.onSocketClose(1006);
      expect(errors).toEqual([]);
    });

    it("leaves the session usable up to the close, then latches", async () => {
      const { shell } = makeShell(true);
      expect(shell.isClosed()).toBe(false);
      await shell.close();
      expect(shell.isClosed()).toBe(true);
    });
  });
});
