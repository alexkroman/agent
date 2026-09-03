// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, it } from "vitest";
import "./_test-matchers.ts";

describe("toBeValidSessionEvent", () => {
  it("passes for a valid event", () => {
    expect({ type: "speech.started" }).toBeValidSessionEvent();
  });

  it("passes for a valid event with fields", () => {
    expect({
      type: "user-transcript.committed",
      text: "hello world",
    }).toBeValidSessionEvent();
  });

  it("fails for an invalid event", () => {
    expect(() => {
      expect({ type: "not_a_real_event" }).toBeValidSessionEvent();
    }).toThrow(/expected value to be a valid session event/);
  });

  it("fails for a missing type field", () => {
    expect(() => {
      expect({ text: "no type" }).toBeValidSessionEvent();
    }).toThrow(/expected value to be a valid session event/);
  });
});

describe("toContainEvent", () => {
  const events = [
    { type: "speech.started" },
    { type: "user-transcript.committed", text: "hello" },
    { type: "tool.called", toolCallId: "tc1", toolName: "search", args: { q: "test" } },
    { type: "reply.completed" },
  ];

  it("finds a matching event by type", () => {
    expect(events).toContainEvent("speech.started");
  });

  it("finds a matching event with fields", () => {
    expect(events).toContainEvent("tool.called", { toolName: "search" });
  });

  it("matches a subset of fields", () => {
    expect(events).toContainEvent("tool.called", {
      toolName: "search",
      args: { q: "test" },
    });
  });

  it("fails when event type is not found", () => {
    expect(() => {
      expect(events).toContainEvent("reply.cancelled");
    }).toThrow(/expected array to contain event of type "reply.cancelled"/);
  });

  it("fails when fields do not match", () => {
    expect(() => {
      expect(events).toContainEvent("tool.called", { toolName: "visit_webpage" });
    }).toThrow(/expected array to contain event of type "tool.called"/);
  });

  it("fails when received value is not an array", () => {
    expect(() => {
      expect("not-an-array").toContainEvent("speech.started");
    }).toThrow(/expected an array of events/);
  });

  it("supports .not negation", () => {
    expect(events).not.toContainEvent("reply.cancelled");
  });
});
