// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { ChannelDeliveryError } from "./channel-types.ts";

describe("ChannelDeliveryError", () => {
  test("carries the channel, status and retry verdict a step branches on", () => {
    const at = new Date(1_700_000_000_000);
    const err = new ChannelDeliveryError("slack refused", {
      channelKind: "slack",
      status: 429,
      retryable: true,
      retryAfter: at,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({
      name: "ChannelDeliveryError",
      message: "slack refused",
      channelKind: "slack",
      status: 429,
      retryable: true,
      retryAfter: at,
    });
  });

  test("a transport failure has no status, and keeps its cause", () => {
    const cause = new TypeError("fetch failed");
    const err = new ChannelDeliveryError("unreachable", {
      channelKind: "textbelt",
      retryable: true,
      cause,
    });
    expect(err.status).toBeUndefined();
    expect(err.retryAfter).toBeUndefined();
    expect(err.cause).toBe(cause);
  });

  test("sets no `cause` at all when none was given", () => {
    const err = new ChannelDeliveryError("x", { channelKind: "slack", retryable: false });
    expect("cause" in err).toBe(false);
  });
});
