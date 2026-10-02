// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { answerUpgrade } from "./_upgrade-reply.ts";

describe("answerUpgrade", () => {
  test("writes a full HTTP response, then destroys the socket", () => {
    const socket = { write: vi.fn(), destroy: vi.fn() };
    answerUpgrade(socket, "302 Found", "moved", ["Location: /x"]);
    expect(socket.write).toHaveBeenCalledWith(
      "HTTP/1.1 302 Found\r\nConnection: close\r\nContent-Type: text/plain\r\nLocation: /x\r\n\r\nmoved",
    );
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(socket.write.mock.invocationCallOrder[0]).toBeLessThan(
      socket.destroy.mock.invocationCallOrder[0] ?? 0,
    );
  });

  test("still destroys the socket when the write throws", () => {
    const socket = {
      write: vi.fn(() => {
        throw new Error("EPIPE");
      }),
      destroy: vi.fn(),
    };
    expect(() => answerUpgrade(socket, "503 Service Unavailable", "busy")).not.toThrow();
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
});
