// Copyright 2026 the AAI authors. MIT license.
/**
 * The raw-`ws` helpers every provider opener shares: a guarded construct, an
 * open bounded by the session's signal, a teardown that leaves exactly one
 * guard listener behind, and the STT PCM wiring. Driven over a hand-rolled
 * socket — no network, no `vi.mock`.
 */

import { EventEmitter } from "node:events";
import { createNanoEvents } from "nanoevents";
import { describe, expect, test, vi } from "vitest";
import { flush, tick } from "../_timing-test-utils.ts";
import { createGuardedWs, dropSocket, openGuardedWs, wireSttPcmSocket } from "./_socket.ts";
import { createSttSessionShell } from "./_utils.ts";
import type { SttEvents } from "./openers.ts";

class FakeSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sent: (string | Uint8Array)[] = [];
  closed = 0;
  terminated = 0;
  send(data: string | Uint8Array, _options?: { binary?: boolean }): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed++;
    this.readyState = 3;
  }
  terminate(): void {
    this.terminated++;
  }
  opened(): void {
    this.readyState = 1;
    this.emit("open");
  }
  /** Every listener on every event. */
  listenersTotal(): number {
    let n = 0;
    for (const event of this.eventNames()) n += this.listenerCount(event);
    return n;
  }
}

const connectError = (message: string) => Object.assign(new Error(message), { code: "connect" });

describe("createGuardedWs", () => {
  test("a constructor throw becomes the provider's connect error, labelled", () => {
    expect(() =>
      createGuardedWs(
        () => {
          throw new Error("bad url");
        },
        connectError,
        "Rime TTS",
      ),
    ).toThrow("Rime TTS: failed to create WebSocket: bad url");
  });

  test("installs an error guard, so a stray socket error is not an uncaught throw", () => {
    const sock = createGuardedWs(() => new FakeSocket(), connectError, "x");
    expect(() => sock.emit("error", new Error("late"))).not.toThrow();
  });
});

describe("dropSocket", () => {
  test("strips every listener but one error guard, and closes", () => {
    const sock = new FakeSocket();
    sock.on("message", () => undefined);
    sock.on("close", () => undefined);
    dropSocket(sock);
    expect(sock.listenersTotal()).toBe(1);
    expect(sock.listenerCount("error")).toBe(1);
    expect(sock.closed).toBe(1);
  });

  test("runs the terminate callback only on an OPEN socket, and survives a throwing one", () => {
    const open = new FakeSocket();
    open.readyState = 1;
    const terminate = vi.fn(() => {
      throw new Error("already gone");
    });
    dropSocket(open, terminate);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(open.closed).toBe(1);

    const connecting = new FakeSocket();
    const never = vi.fn();
    dropSocket(connecting, never);
    expect(never).not.toHaveBeenCalled();
  });
});

describe("openGuardedWs", () => {
  test("resolves once open, after running the first-frame hook", async () => {
    const sock = new FakeSocket();
    const opening = openGuardedWs({
      create: () => sock,
      label: "Soniox STT",
      makeConnectError: connectError,
      signal: new AbortController().signal,
      onOpen: (ws) => ws.send('{"config":true}'),
    });
    sock.opened();
    await expect(opening).resolves.toBe(sock);
    expect(sock.sent).toEqual(['{"config":true}']);
  });

  test("a socket error before open rejects labelled, and drops the socket", async () => {
    const sock = new FakeSocket();
    const opening = openGuardedWs({
      create: () => sock,
      label: "Soniox STT",
      makeConnectError: connectError,
      signal: new AbortController().signal,
    });
    await flush();
    sock.emit("error", new Error("ECONNREFUSED"));
    await expect(opening).rejects.toThrow("Soniox STT: connect failed: ECONNREFUSED");
    expect(sock.closed).toBe(1);
    expect(sock.listenersTotal()).toBe(1);
  });

  test("a throwing first frame rejects and drops the socket", async () => {
    const sock = new FakeSocket();
    const opening = openGuardedWs({
      create: () => sock,
      label: "Rime TTS",
      makeConnectError: connectError,
      signal: new AbortController().signal,
      onOpen: () => {
        throw new Error("config refused");
      },
    });
    sock.opened();
    await expect(opening).rejects.toThrow("Rime TTS: connect failed: config refused");
    expect(sock.closed).toBe(1);
  });

  test("an abort abandons the connect", async () => {
    const sock = new FakeSocket();
    const controller = new AbortController();
    const opening = openGuardedWs({
      create: () => sock,
      label: "Rime TTS",
      makeConnectError: connectError,
      signal: controller.signal,
    });
    controller.abort(new Error("hung up"));
    await expect(opening).rejects.toThrow(/Rime TTS: connect failed/);
    expect(sock.closed).toBe(1);
  });
});

describe("wireSttPcmSocket", () => {
  function wired() {
    const sock = new FakeSocket();
    sock.readyState = 1;
    const emitter = createNanoEvents<SttEvents>();
    const teardown = vi.fn();
    const shell = createSttSessionShell({ emitter, teardown });
    const controller = new AbortController();
    const send = wireSttPcmSocket(sock, shell, controller.signal, "Test STT");
    const errors: Error[] = [];
    emitter.on("error", (err) => errors.push(err));
    return { sock, shell, controller, send, errors, teardown };
  }

  test("sends PCM as binary bytes while open, and nothing once the socket is not", () => {
    const { sock, send } = wired();
    send(new Int16Array([1, -1]));
    expect(sock.sent).toEqual([new Uint8Array([1, 0, 255, 255])]);
    sock.readyState = 3;
    send(new Int16Array([2]));
    expect(sock.sent).toHaveLength(1);
  });

  test("a socket error or an abnormal close is a stream error on the session", () => {
    const { sock, errors } = wired();
    sock.emit("error", new Error("reset"));
    sock.emit("close", 1006);
    expect(errors.map((err) => err.message)).toEqual(["reset", "socket closed 1006"]);
  });

  test("an abort closes the session, after which nothing is sent", async () => {
    const { sock, send, controller, teardown, shell } = wired();
    controller.abort();
    await tick();
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(shell.isClosed()).toBe(true);
    send(new Int16Array([1]));
    expect(sock.sent).toEqual([]);
  });
});
