import { describe, expect, test } from "vitest";
import type { Transport, TransportCallbacks } from "./types.ts";

describe("Transport types", () => {
  test("file compiles", () => {
    const noop = (): void => undefined;
    const stub: Transport = {
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      sendUserAudio: noop,
      sendToolResult: noop,
      cancelReply: noop,
    };
    expect(stub).toBeDefined();

    type _CB = TransportCallbacks;
  });
});
