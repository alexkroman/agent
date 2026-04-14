// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, expectTypeOf, it, test } from "vitest";
import type { Session } from "./context.ts";
import type { SessionCore, SessionSnapshot } from "./session-core.ts";
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
    expectTypeOf<ToolCallInfo>().toHaveProperty("afterMessageIndex");
  });

  it("does not have old field names", () => {
    // @ts-expect-error -- toolCallId was renamed to callId
    expectTypeOf<ToolCallInfo>().toHaveProperty("toolCallId");
    // @ts-expect-error -- toolName was renamed to name
    expectTypeOf<ToolCallInfo>().toHaveProperty("toolName");
  });
});

describe("AgentState", () => {
  it("includes all expected states", () => {
    const states: AgentState[] = [
      "disconnected",
      "connecting",
      "ready",
      "listening",
      "thinking",
      "speaking",
      "error",
    ];
    expect(states).toHaveLength(7);
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

describe("SessionCore type contract", () => {
  test("has subscribe/getSnapshot/connect/disconnect/cancel/start/toggle", () => {
    expectTypeOf<SessionCore["subscribe"]>().toBeFunction();
    expectTypeOf<SessionCore["getSnapshot"]>().toBeFunction();
    expectTypeOf<SessionCore["connect"]>().toBeFunction();
    expectTypeOf<SessionCore["disconnect"]>().toBeFunction();
    expectTypeOf<SessionCore["cancel"]>().toBeFunction();
    expectTypeOf<SessionCore["start"]>().toBeFunction();
    expectTypeOf<SessionCore["toggle"]>().toBeFunction();
  });

  test("getSnapshot returns SessionSnapshot", () => {
    expectTypeOf<SessionCore["getSnapshot"]>().returns.toEqualTypeOf<SessionSnapshot>();
  });
});

describe("SessionSnapshot type contract", () => {
  test("has expected field types", () => {
    expectTypeOf<SessionSnapshot["state"]>().toEqualTypeOf<AgentState>();
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
