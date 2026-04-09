// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, expectTypeOf, it, test } from "vitest";
import type { AgentState, ClientTheme, ToolCallInfo } from "./types.ts";
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
  it("does not include error as a state", () => {
    const states: AgentState[] = [
      "disconnected",
      "connecting",
      "ready",
      "listening",
      "thinking",
      "speaking",
    ];
    expect(states).toHaveLength(6);
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
