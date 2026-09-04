// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { clientEventDropMessage, decideClientEvent } from "./client-event.ts";
import { MAX_CLIENT_EVENT_NAME_LENGTH, MAX_CLIENT_EVENT_PAYLOAD_BYTES } from "./constants.ts";

describe("decideClientEvent", () => {
  test("an event within the caps carries its JSON", () => {
    expect(decideClientEvent("progress", { done: true })).toEqual({ json: '{"done":true}' });
  });

  test("undefined data is sent as null, the way the wire spells absent", () => {
    expect(decideClientEvent("tick", undefined)).toEqual({ json: "null" });
  });

  test("the payload is measured in UTF-8 bytes, not characters", () => {
    // A multi-byte string under the cap by `length` and over it by bytes: the
    // socket carries bytes, so that is what the decision has to count.
    const chars = Math.ceil(MAX_CLIENT_EVENT_PAYLOAD_BYTES / 3) + 1;
    const decision = decideClientEvent("wide", "☃".repeat(chars));
    expect(decision).toEqual({ drop: { reason: "too-large", detail: expect.any(String) } });
    expect(JSON.stringify("☃".repeat(chars)).length).toBeLessThan(MAX_CLIENT_EVENT_PAYLOAD_BYTES);
  });

  test("an over-long name is refused before the payload is even serialized", () => {
    const decision = decideClientEvent("e".repeat(MAX_CLIENT_EVENT_NAME_LENGTH + 1), 1);
    expect(decision).toEqual({
      drop: { reason: "name-too-long", detail: expect.stringContaining("cap") },
    });
  });

  test("a name exactly at the cap is allowed — the protocol schema's boundary", () => {
    expect(decideClientEvent("e".repeat(MAX_CLIENT_EVENT_NAME_LENGTH), 1)).toEqual({ json: "1" });
  });

  test("a cycle is a drop, never a throw", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // The caller is a tool body, so a throw here fails the tool call over a
    // fire-and-forget notification.
    expect(decideClientEvent("cycle", cyclic)).toEqual({
      drop: { reason: "unserializable", detail: expect.any(String) },
    });
  });

  test("a BigInt is a drop for the same reason", () => {
    expect(decideClientEvent("big", { n: 1n })).toEqual({
      drop: { reason: "unserializable", detail: expect.any(String) },
    });
  });

  test("a value with no JSON form is named as that, not as unserializable", () => {
    // `JSON.stringify(() => {})` neither throws nor produces output, and the
    // two need different remedies — one is a shape to fix, this is a value
    // that was never sendable.
    expect(decideClientEvent("fn", () => 1)).toEqual({
      drop: { reason: "no-json-form", detail: "payload is a function" },
    });
  });
});

describe("clientEventDropMessage", () => {
  test("names the event and the reason", () => {
    const message = clientEventDropMessage("progress", { reason: "too-large", detail: "99 bytes" });
    expect(message).toBe('ctx.send("progress") was not sent: too-large (99 bytes)');
  });

  test("truncates the name, since an over-long one is itself a drop reason", () => {
    const message = clientEventDropMessage("e".repeat(300), {
      reason: "name-too-long",
      detail: "300 characters",
    });
    expect(message).toContain("…");
    expect(message.length).toBeLessThan(160);
  });
});
