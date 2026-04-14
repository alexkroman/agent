// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, it } from "vitest";
import "./_test-matchers.ts";

describe("toBeValidClientEvent", () => {
  it("passes for a valid event", () => {
    expect({ type: "speech_started" }).toBeValidClientEvent();
  });

  it("passes for a valid event with fields", () => {
    expect({
      type: "user_transcript",
      text: "hello world",
    }).toBeValidClientEvent();
  });

  it("fails for an invalid event", () => {
    expect(() => {
      expect({ type: "not_a_real_event" }).toBeValidClientEvent();
    }).toThrow(/expected value to be a valid ClientEvent/);
  });

  it("fails for a missing type field", () => {
    expect(() => {
      expect({ text: "no type" }).toBeValidClientEvent();
    }).toThrow(/expected value to be a valid ClientEvent/);
  });
});

describe("toContainEvent", () => {
  const events = [
    { type: "speech_started" },
    { type: "user_transcript", text: "hello" },
    { type: "tool_call", toolCallId: "tc1", toolName: "search", args: { q: "test" } },
    { type: "reply_done" },
  ];

  it("finds a matching event by type", () => {
    expect(events).toContainEvent("speech_started");
  });

  it("finds a matching event with fields", () => {
    expect(events).toContainEvent("tool_call", { toolName: "search" });
  });

  it("matches a subset of fields", () => {
    expect(events).toContainEvent("tool_call", {
      toolName: "search",
      args: { q: "test" },
    });
  });

  it("fails when event type is not found", () => {
    expect(() => {
      expect(events).toContainEvent("cancelled");
    }).toThrow(/expected array to contain event of type "cancelled"/);
  });

  it("fails when fields do not match", () => {
    expect(() => {
      expect(events).toContainEvent("tool_call", { toolName: "visit_webpage" });
    }).toThrow(/expected array to contain event of type "tool_call"/);
  });

  it("fails when received value is not an array", () => {
    expect(() => {
      expect("not-an-array").toContainEvent("speech_started");
    }).toThrow(/expected an array of events/);
  });

  it("supports .not negation", () => {
    expect(events).not.toContainEvent("cancelled");
  });
});
