// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { bridgePeerSocket } from "./session-socket-bridge.ts";

const WS_OPEN = 1;
const WS_CLOSED = 3;

function fakePeer() {
  return {
    send: vi.fn((_data: unknown) => 0),
    close: vi.fn((_code?: number, _reason?: string) => undefined),
  };
}

describe("bridgePeerSocket", () => {
  test("starts open (eve upgrades before the open hook fires)", () => {
    const bridge = bridgePeerSocket(fakePeer());
    expect(bridge.socket.readyState).toBe(WS_OPEN);
  });

  test("send forwards to the peer", () => {
    const peer = fakePeer();
    const bridge = bridgePeerSocket(peer);
    bridge.socket.send("frame");
    const bytes = new Uint8Array([1, 2]);
    bridge.socket.send(bytes);
    expect(peer.send).toHaveBeenCalledWith("frame");
    expect(peer.send).toHaveBeenCalledWith(bytes);
  });

  test("dispatchers reach the registered listeners with event shapes", () => {
    const bridge = bridgePeerSocket(fakePeer());
    const open = vi.fn();
    const message = vi.fn();
    const close = vi.fn();
    const error = vi.fn();
    bridge.socket.addEventListener("open", open);
    bridge.socket.addEventListener("message", message);
    bridge.socket.addEventListener("close", close);
    bridge.socket.addEventListener("error", error);

    bridge.dispatchOpen();
    bridge.dispatchMessage("hello");
    bridge.dispatchError("boom");
    bridge.dispatchClose({ code: 1000, reason: "done" });

    expect(open).toHaveBeenCalledTimes(1);
    expect(message).toHaveBeenCalledWith({ data: "hello" });
    expect(error).toHaveBeenCalledWith({ message: "boom" });
    expect(close).toHaveBeenCalledWith({ code: 1000, reason: "done" });
  });

  test("socket close and dispatchClose both mark the socket closed", () => {
    const peer = fakePeer();
    const a = bridgePeerSocket(peer);
    a.socket.close?.(1001, "bye");
    expect(a.socket.readyState).toBe(WS_CLOSED);
    expect(peer.close).toHaveBeenCalledWith(1001, "bye");

    const b = bridgePeerSocket(fakePeer());
    b.dispatchClose();
    expect(b.socket.readyState).toBe(WS_CLOSED);
  });

  test("a dispatch with no listeners is a no-op", () => {
    const bridge = bridgePeerSocket(fakePeer());
    expect(() => {
      bridge.dispatchOpen();
      bridge.dispatchMessage(new Uint8Array(0));
      bridge.dispatchError();
      bridge.dispatchClose();
    }).not.toThrow();
  });
});
