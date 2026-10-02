// Copyright 2026 the AAI authors. MIT license.
/**
 * The process-wide platform-socket registry: one socket per base, offered only
 * while open, and empty until something opens one.
 */

import { afterEach, describe, expect, test } from "vitest";
import type { HeaderWebSocket } from "../_ws.ts";
import {
  closePlatformSockets,
  ensurePlatformSocket,
  platformSocketFor,
} from "./socket-registry.ts";

const BASE = "https://api.test/my-agent";
const TOKEN = "sandbox-bearer";

/** A `ws`-shaped socket a spec opens by hand; it never answers anything. */
function fakeSocket() {
  let readyState = 0;
  // `data` is REQUIRED, because the message overload declares it so.
  type Listener = (event: { data: unknown; code?: number; message?: string }) => void;
  const opened: Listener[] = [];
  const socket: HeaderWebSocket = {
    get readyState(): number {
      return readyState;
    },
    send(): void {
      // Nothing is sent: this file's subject is the registry, not the socket.
    },
    close(): void {
      readyState = 3;
    },
    addEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
      if (type === "open") opened.push(listener);
    },
  };
  return {
    socket,
    open(): void {
      readyState = 1;
      for (const listener of opened) listener({ data: undefined });
    },
  };
}

afterEach(() => {
  closePlatformSockets();
});

describe("the registry is what a caller consults", () => {
  test("is empty until something opens one, so nothing dials by accident", () => {
    // The property that keeps a unit test off the network: only
    // `installWorkflowSupport` calls `ensurePlatformSocket`.
    expect(platformSocketFor({ base: BASE, token: TOKEN })).toBeUndefined();
  });

  test("hands back one socket per base, and closes them all", () => {
    const peer = fakeSocket();
    const first = ensurePlatformSocket({ base: BASE, token: TOKEN }, { create: () => peer.socket });
    const second = ensurePlatformSocket(
      { base: BASE, token: TOKEN },
      { create: () => peer.socket },
    );
    expect(second).toBe(first);
    peer.open();
    expect(platformSocketFor({ base: BASE, token: TOKEN })).toBe(first);
    closePlatformSockets();
    expect(platformSocketFor({ base: BASE, token: TOKEN })).toBeUndefined();
  });

  test("a socket that is not open is not offered", () => {
    const peer = fakeSocket();
    ensurePlatformSocket({ base: BASE, token: TOKEN }, { create: () => peer.socket });
    expect(platformSocketFor({ base: BASE, token: TOKEN })).toBeUndefined();
  });
});
