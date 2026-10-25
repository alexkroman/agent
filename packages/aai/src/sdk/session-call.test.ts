// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test, vi } from "vitest";
import { createToolContext } from "./_testing-context.ts";
import {
  type SessionCall,
  type SessionCallInput,
  sessionCall,
  setSessionCall,
} from "./session-call.ts";

afterEach(() => vi.useRealTimers());

const CALL: SessionCallInput = {
  carrier: "twilio",
  callId: "CA00000000000000000000000000000001",
  parameters: { call: "c_81f2" },
};

describe("sessionCall", () => {
  test("answers the call recorded for the session, and undefined for any other", () => {
    setSessionCall("call-a", CALL);
    expect(sessionCall({ sessionId: "call-a" })).toEqual(CALL);
    expect(sessionCall({ sessionId: "call-unknown" })).toBeUndefined();
  });

  test("the recorded call is frozen, parameters too, so no reader can change it for another", () => {
    const parameters: Record<string, string> = { call: "c_1" };
    setSessionCall("call-b", { carrier: "twilio", parameters });
    // A caller mutating what it passed in does not reach the record either.
    parameters.call = "c_forged";
    const call = sessionCall({ sessionId: "call-b" });
    expect(call?.parameters).toEqual({ call: "c_1" });
    expect(Object.isFrozen(call)).toBe(true);
    expect(Object.isFrozen(call?.parameters)).toBe(true);
  });

  test("the recorded call reads its own brief, and the reader is not data", async () => {
    const { signCallBrief } = await import("./call-brief.ts");
    const parameters = await signCallBrief({ id: "call_7", prompt: "Say hello." }, "s3cret");
    setSessionCall("call-d", { carrier: "twilio", parameters: { ...parameters, for: "Sam" } });
    const call = sessionCall({ sessionId: "call-d" });
    expect(await call?.brief("s3cret")).toEqual({ id: "call_7", prompt: "Say hello." });
    expect(await call?.brief("wrong")).toBeUndefined();
    expect(await call?.brief(undefined)).toBeUndefined();
    // Non-enumerable: a log line or a deep equality sees the call as data.
    expect(Object.keys(call ?? {})).toEqual(["carrier", "parameters"]);
    expect(call).toEqual({ carrier: "twilio", parameters: { ...parameters, for: "Sam" } });
  });

  test("the store is shared through globalThis, so a second copy of the module reads it", () => {
    setSessionCall("call-c", CALL);
    const store = (globalThis as Record<symbol, Map<string, { call: SessionCall }> | undefined>)[
      Symbol.for("@alexkroman1/aai.sessionCalls")
    ];
    expect(store?.get("call-c")?.call.callId).toBe(CALL.callId);
  });

  test("an entry expires after a day", () => {
    vi.useFakeTimers();
    setSessionCall("call-d", CALL);
    vi.advanceTimersByTime(86_400_001);
    expect(sessionCall({ sessionId: "call-d" })).toBeUndefined();
  });

  test("createToolContext({ call }) seeds it for the context's session, and only that one", () => {
    expect(sessionCall(createToolContext({ call: CALL }))).toEqual(CALL);
    expect(sessionCall(createToolContext())).toBeUndefined();
  });
});
