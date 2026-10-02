// Copyright 2026 the AAI authors. MIT license.
/**
 * The one `emitError` every transport reports failures through: an
 * `error.reported` event, FATAL unless the reporter says otherwise.
 */

import { describe, expect, test } from "vitest";
import { makeCallbacks } from "./_transport-recorder.ts";
import { createEmitError } from "./emit-error.ts";

describe("createEmitError", () => {
  test("reports a fatal error by default", () => {
    const callbacks = makeCallbacks();
    createEmitError(callbacks)("stt", "socket closed");
    expect(callbacks.events).toEqual([
      { type: "error.reported", code: "stt", message: "socket closed", fatal: true },
    ]);
  });

  test("a reporter that says `fatal: false` keeps the session alive", () => {
    const callbacks = makeCallbacks();
    const emitError = createEmitError(callbacks);
    emitError("llm", "rate limited", { fatal: false });
    emitError("tts", "gone", {});
    expect(callbacks.events.map((e) => e.type === "error.reported" && e.fatal)).toEqual([
      false,
      true,
    ]);
  });
});
