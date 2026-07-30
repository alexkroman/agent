// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { routeAgentHandle, type VoiceSessionLike } from "./route-agent-handle.ts";

function fakeSession(id: string): VoiceSessionLike & { cancel: ReturnType<typeof vi.fn> } {
  return {
    id,
    continuationToken: `tok-${id}`,
    cancel: vi.fn(async () => ({ status: "accepted" })),
    getEventStream: vi.fn(async () => new ReadableStream()),
  };
}

describe("routeAgentHandle", () => {
  test("run() sends the first message in conversation mode under the supplied token", async () => {
    const session = fakeSession("es-1");
    const send = vi.fn(async () => session);
    const handle = routeAgentHandle({ send, getSession: () => session });

    const result = await handle.run({
      mode: "conversation",
      input: { message: "hello" },
      continuationToken: "voice:sid-1",
    });

    expect(result).toEqual({ sessionId: "es-1" });
    expect(send).toHaveBeenCalledWith(
      { message: "hello" },
      { auth: null, continuationToken: "voice:sid-1", mode: "conversation" },
    );
  });

  test("deliver() is the same send keyed by the continuation token", async () => {
    const session = fakeSession("es-1");
    const send = vi.fn(async () => session);
    const handle = routeAgentHandle({ send, getSession: () => session });

    const result = await handle.deliver({
      continuationToken: "tok-2",
      payload: { message: "again" },
    });

    expect(result).toEqual({ sessionId: "es-1" });
    expect(send).toHaveBeenCalledWith(
      { message: "again" },
      { auth: null, continuationToken: "tok-2", mode: "conversation" },
    );
  });

  test("cancelTurn() resolves the session by id and forwards the turn guard", async () => {
    const session = fakeSession("es-9");
    const getSession = vi.fn(() => session);
    const handle = routeAgentHandle({ send: vi.fn(async () => session), getSession });

    await handle.cancelTurn({ sessionId: "es-9", turnId: "t3" });
    expect(getSession).toHaveBeenCalledWith("es-9");
    expect(session.cancel).toHaveBeenCalledWith({ turnId: "t3" });

    await handle.cancelTurn({ sessionId: "es-9" });
    expect(session.cancel).toHaveBeenLastCalledWith({});
  });

  test("getEventStream() forwards the cursor", async () => {
    const session = fakeSession("es-9");
    const handle = routeAgentHandle({
      send: vi.fn(async () => session),
      getSession: () => session,
    });

    await handle.getEventStream("es-9", { startIndex: 42 });
    expect(session.getEventStream).toHaveBeenCalledWith({ startIndex: 42 });
  });
});
