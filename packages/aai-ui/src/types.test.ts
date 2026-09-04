// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, expectTypeOf, it, test } from "vitest";
import type { Session } from "./context.ts";
import type { BrowserSession, SessionSnapshot } from "./session-core-types.ts";
import type { AgentState, ChatMessage, ClientTheme, SessionError, ToolCallInfo } from "./types.ts";
import { MIC_BUFFER_SECONDS } from "./types.ts";

describe("types", () => {
  test("MIC_BUFFER_SECONDS equals 0.1", () => {
    expect(MIC_BUFFER_SECONDS).toBe(0.1);
  });
});

describe("ToolCallInfo", () => {
  it("uses S2S-aligned field names", () => {
    expectTypeOf<ToolCallInfo>().toHaveProperty("callId");
    expectTypeOf<ToolCallInfo>().toHaveProperty("name");
    expectTypeOf<ToolCallInfo>().toHaveProperty("args");
    expectTypeOf<ToolCallInfo>().toHaveProperty("status");
    expectTypeOf<ToolCallInfo>().toHaveProperty("result");
    expectTypeOf<ToolCallInfo>().toHaveProperty("seq");
    expectTypeOf<ToolCallInfo>().toHaveProperty("afterMessageId");
  });

  it("does not have old field names", () => {
    // @ts-expect-error -- toolCallId was renamed to callId
    expectTypeOf<ToolCallInfo>().toHaveProperty("toolCallId");
    // @ts-expect-error -- toolName was renamed to name
    expectTypeOf<ToolCallInfo>().toHaveProperty("toolName");
  });
});

describe("AgentState", () => {
  it("is exactly the seven states a client switches on", () => {
    // This used to be an `AgentState[]` literal followed by `toHaveLength(7)`,
    // which counted the array on the line above it. That catches a REMOVED
    // member — the literal stops being assignable — and a member ADDED to the
    // union was caught by nothing, which is the direction that matters: a
    // client exhaustively switching on this compiles against seven arms and
    // silently falls through the eighth. `toEqualTypeOf` is exact in both
    // directions, and `tsc` is what runs it (see "Type-level tests" in the root
    // guide — a mismatch is a hard compile error, not a skipped assertion).
    expectTypeOf<AgentState>().toEqualTypeOf<
      "disconnected" | "connecting" | "ready" | "listening" | "thinking" | "speaking" | "error"
    >();

    // The same seven as values, so the list stays readable as a list and a
    // rename fails here too.
    const states = [
      "disconnected",
      "connecting",
      "ready",
      "listening",
      "thinking",
      "speaking",
      "error",
    ] as const satisfies readonly AgentState[];
    expect(new Set(states).size).toBe(states.length);
  });
});

describe("ClientTheme", () => {
  it("has the expected color fields", () => {
    expectTypeOf<ClientTheme>().toHaveProperty("bg");
    expectTypeOf<ClientTheme>().toHaveProperty("primary");
    expectTypeOf<ClientTheme>().toHaveProperty("text");
    expectTypeOf<ClientTheme>().toHaveProperty("surface");
    expectTypeOf<ClientTheme>().toHaveProperty("border");
  });
});

describe("BrowserSession type contract", () => {
  test("has subscribe/getSnapshot/connect/disconnect/cancel/start/toggle", () => {
    expectTypeOf<BrowserSession["subscribe"]>().toBeFunction();
    expectTypeOf<BrowserSession["getSnapshot"]>().toBeFunction();
    expectTypeOf<BrowserSession["connect"]>().toBeFunction();
    expectTypeOf<BrowserSession["disconnect"]>().toBeFunction();
    expectTypeOf<BrowserSession["cancel"]>().toBeFunction();
    expectTypeOf<BrowserSession["start"]>().toBeFunction();
    expectTypeOf<BrowserSession["toggle"]>().toBeFunction();
  });

  test("getSnapshot returns SessionSnapshot", () => {
    expectTypeOf<BrowserSession["getSnapshot"]>().returns.toEqualTypeOf<SessionSnapshot>();
  });
});

describe("ChatMessage", () => {
  it("carries a stable numeric id", () => {
    expectTypeOf<ChatMessage>().toHaveProperty("id");
    expectTypeOf<ChatMessage["id"]>().toEqualTypeOf<number>();
  });
});

describe("SessionSnapshot type contract", () => {
  test("has expected field types", () => {
    expectTypeOf<SessionSnapshot["state"]>().toEqualTypeOf<AgentState>();
    expectTypeOf<SessionSnapshot["contentVersion"]>().toEqualTypeOf<number>();
    expectTypeOf<SessionSnapshot["messages"]>().toEqualTypeOf<ChatMessage[]>();
    expectTypeOf<SessionSnapshot["error"]>().toEqualTypeOf<SessionError | null>();
    expectTypeOf<SessionSnapshot["started"]>().toEqualTypeOf<boolean>();
    expectTypeOf<SessionSnapshot["running"]>().toEqualTypeOf<boolean>();
  });
});

describe("Session type contract", () => {
  test("extends SessionSnapshot with control methods", () => {
    expectTypeOf<Session>().toMatchTypeOf<SessionSnapshot>();
    expectTypeOf<Session["start"]>().toBeFunction();
    expectTypeOf<Session["cancel"]>().toBeFunction();
    expectTypeOf<Session["disconnect"]>().toBeFunction();
    expectTypeOf<Session["toggle"]>().toBeFunction();
  });
});
