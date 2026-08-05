// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, it } from "vitest";
import { createSessionShell } from "./_utils.ts";

/** Collect the messages a shell surfaces, with a no-op teardown. */
function makeShell(cleanCloseIsFatal?: boolean) {
  const errors: string[] = [];
  const shell = createSessionShell({
    makeStreamError: (message) => new Error(message),
    emitError: (err) => errors.push(err.message),
    teardown: () => {
      // No connection to release; these tests exercise close semantics only.
    },
    ...(cleanCloseIsFatal === undefined ? {} : { cleanCloseIsFatal }),
  });
  return { shell, errors };
}

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
