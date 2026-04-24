import { describe, expect, test } from "vitest";
import type { Transport, TransportCallbacks } from "./types.ts";

describe("Transport types", () => {
  test("file compiles", () => {
    // Types only; runtime check is trivial.
    const stub: Transport = {
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
      sendUserAudio: () => {},
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
      sendToolResult: () => {},
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
      cancelReply: () => {},
    };
    expect(stub).toBeDefined();

    // Ensure TransportCallbacks is referenced (type-only check).
    type _CB = TransportCallbacks;
  });
});
