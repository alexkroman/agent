// Copyright 2026 the AAI authors. MIT license.
// `safeSend`, the one send every session frame goes through: nothing reaches a
// socket that is not OPEN, and a send that throws on the close race is
// contained.

import type { ClientSink } from "@alexkroman1/aai/protocol";
import { describe, expect, test } from "vitest";
import { makeLogger, silentLogger } from "../_logger-test-utils.ts";
import { MockWebSocket } from "../_mock-ws.ts";
import { makeMockCore } from "../_session-test-utils.ts";
import { defaultConfig, openSocket } from "./_ws-handler-test-utils.ts";
import { createSessionDirectory } from "./directory.ts";
import { stampSessionEvent } from "./event-stream.ts";
import { asSessionWebSocket, safeSend } from "./ws-frames.ts";
import { wireSessionSocket } from "./ws-handler.ts";

describe("safeSend", () => {
  test("sends only while the socket is OPEN", () => {
    const ws = new MockWebSocket("ws://test");
    safeSend(ws, "early", silentLogger);
    ws.readyState = MockWebSocket.OPEN;
    safeSend(ws, "now", silentLogger);
    ws.readyState = MockWebSocket.CLOSED;
    safeSend(ws, "late", silentLogger);
    expect(ws.sent).toEqual(["now"]);
  });

  test("a send that throws is logged at debug and not rethrown", () => {
    const logger = makeLogger();
    const ws = asSessionWebSocket({
      readyState: MockWebSocket.OPEN,
      send: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => safeSend(ws, "x", logger)).not.toThrow();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("safeSend"),
      expect.objectContaining({ error: "EPIPE" }),
    );
  });
});

describe("through a wired session socket", () => {
  test("ClientSink tolerates ws.send throwing (closed socket)", () => {
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

    ws.send = () => {
      throw new Error("socket closed");
    };
    // A send that throws must be contained — a closed socket is the normal
    // end of every session, and an escaping throw from the sink takes out
    // whatever transport callback was writing. Stated as an assertion rather
    // than left to the test merely not failing.
    expect(() => capturedClient.event(stampSessionEvent({ type: "speech.started" }))).not.toThrow();
    expect(() => capturedClient.playAudioChunk(new Uint8Array([1]))).not.toThrow();
    expect(() =>
      capturedClient.event(stampSessionEvent({ type: "audio.completed" })),
    ).not.toThrow();
  });
});
