// Copyright 2026 the AAI authors. MIT license.
// The client sink a session socket is wired with (`createClientSink`): JSON
// text frames for events, raw binary frames for audio, and the stalled-client
// guard — driven through `wireSessionSocket`, which is where a sink is made.

import type { ClientSink } from "@alexkroman1/aai/protocol";
import { describe, expect, test, vi } from "vitest";
import { makeLogger, silentLogger } from "../_logger-test-utils.ts";
import { MockWebSocket } from "../_mock-ws.ts";
import { makeMockCore } from "../_session-test-utils.ts";
import { defaultConfig, openSocket } from "./_ws-handler-test-utils.ts";
import { createSessionDirectory } from "./directory.ts";
import { stampSessionEvent } from "./event-stream.ts";
import { wireSessionSocket } from "./ws-handler.ts";

describe("the session socket's ClientSink", () => {
  test("ClientSink.open reflects ws.readyState", () => {
    let capturedClient!: ClientSink;
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: createSessionDirectory(),
      createSession: (_sid, client) => {
        capturedClient = client;
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    expect(capturedClient.open).toBe(true);
    ws.readyState = MockWebSocket.CLOSED;
    expect(capturedClient.open).toBe(false);
  });

  test("ClientSink.playAudioChunk sends raw binary Uint8Array", () => {
    let capturedClient!: ClientSink;
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: createSessionDirectory(),
      createSession: (_sid, client) => {
        capturedClient = client;
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    const chunk = new Uint8Array([10, 20, 30]);
    capturedClient.playAudioChunk(chunk);

    const binaryFrames = (ws.sent as unknown[]).filter((d) => d instanceof Uint8Array);
    expect(binaryFrames.length).toBeGreaterThanOrEqual(1);
    expect(binaryFrames[0]).toBe(chunk);
  });

  test("an audio.completed event goes out as a JSON text frame", () => {
    let capturedClient!: ClientSink;
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: createSessionDirectory(),
      createSession: (_sid, client) => {
        capturedClient = client;
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    capturedClient.event(stampSessionEvent({ type: "audio.completed" }));

    expect(ws.sentJson().find((m) => m.type === "audio.completed")).toBeDefined();
  });

  test("playAudioChunk closes a stalled client once the socket buffer exceeds the cap", async () => {
    let capturedClient!: ClientSink;
    const ws = openSocket();
    const logger = makeLogger();
    const sessions = createSessionDirectory();
    const closeSpy = vi.spyOn(ws, "close");

    wireSessionSocket(ws, {
      sessions,
      createSession: (_sid, client) => {
        capturedClient = client;
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger,
    });

    // Below the cap: audio flows.
    ws.bufferedAmount = 1024;
    capturedClient.playAudioChunk(new Uint8Array([1]));
    expect((ws.sent as unknown[]).filter((d) => d instanceof Uint8Array)).toHaveLength(1);

    // Past the cap: the client is stalled — warn once and close the socket.
    ws.bufferedAmount = 5 * 1024 * 1024;
    capturedClient.playAudioChunk(new Uint8Array([2]));
    capturedClient.playAudioChunk(new Uint8Array([3]));

    expect(closeSpy).toHaveBeenCalledOnce();
    expect(closeSpy).toHaveBeenCalledWith(1008, "audio backlog exceeded");
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      "ws: client audio backlog exceeded; closing stalled connection",
      expect.objectContaining({ bufferedBytes: 5 * 1024 * 1024 }),
    );
    // No further audio was sent after the stall was detected.
    expect((ws.sent as unknown[]).filter((d) => d instanceof Uint8Array)).toHaveLength(1);

    // MockWebSocket.close dispatches `close`, so normal teardown runs.
    await vi.waitFor(() => {
      expect(sessions.size).toBe(0);
    });
  });

  test("playAudioChunk skips the backpressure guard when bufferedAmount is unavailable", () => {
    let capturedClient!: ClientSink;
    const ws = openSocket();
    // Simulate a socket abstraction without bufferedAmount.
    (ws as { bufferedAmount: number | undefined }).bufferedAmount = undefined;

    wireSessionSocket(ws, {
      sessions: createSessionDirectory(),
      createSession: (_sid, client) => {
        capturedClient = client;
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    capturedClient.playAudioChunk(new Uint8Array([1]));
    expect((ws.sent as unknown[]).filter((d) => d instanceof Uint8Array)).toHaveLength(1);
  });
});
