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

describe("toBeValidServerMessage", () => {
  it("passes for a valid server message", () => {
    expect({ type: "audio_done" }).toBeValidServerMessage();
  });

  it("passes for a config message", () => {
    expect({
      type: "config",
      audioFormat: "pcm16",
      sampleRate: 16_000,
      ttsSampleRate: 24_000,
    }).toBeValidServerMessage();
  });

  it("fails for an invalid message", () => {
    expect(() => {
      expect({ type: "bogus_type" }).toBeValidServerMessage();
    }).toThrow(/expected value to be a valid ServerMessage/);
  });
});

describe("toBeValidManifest", () => {
  it("passes for a valid manifest", () => {
    expect({ name: "test-agent" }).toBeValidManifest();
  });

  it("passes for a manifest with optional fields", () => {
    expect({
      name: "test-agent",
      greeting: "Hi there!",
      maxSteps: 3,
      builtinTools: ["web_search"],
    }).toBeValidManifest();
  });

  it("fails for a manifest missing name", () => {
    expect(() => {
      expect({}).toBeValidManifest();
    }).toThrow(/expected value to be a valid Manifest/);
  });

  it("fails for a manifest with empty name", () => {
    expect(() => {
      expect({ name: "" }).toBeValidManifest();
    }).toThrow(/expected value to be a valid Manifest/);
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
