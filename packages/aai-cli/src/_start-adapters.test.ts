// Copyright 2026 the AAI authors. MIT license.
/**
 * The two thin adapters onto the process: `nodeCluster` (driven through
 * `node:cluster`'s own emitter — nothing is forked) and `processLink` (driven
 * through an injected process, so the test runner's IPC is never touched).
 */

import cluster from "node:cluster";
import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type IpcProcess, processLink } from "./_start-worker.ts";
import { nodeCluster, type WorkerMessage } from "./_start-workers.ts";

afterEach(() => {
  cluster.removeAllListeners("message");
  cluster.removeAllListeners("exit");
});

/** Something shaped like a `cluster.Worker`, as `node:cluster` would emit it. */
function emittedWorker(connected = true) {
  return {
    process: { pid: 4242, kill: vi.fn() },
    isConnected: () => connected,
    send: vi.fn(),
  };
}

describe("nodeCluster", () => {
  test("wraps an emitting worker ONCE, forwarding messages, kills and sends", () => {
    const adapter = nodeCluster();
    const raw = emittedWorker();
    const seen: unknown[] = [];
    adapter.onMessage((worker, message) => seen.push([worker, message]));
    cluster.emit("message", raw, { type: "aai-start:listening" });
    cluster.emit("message", raw, { type: "aai-start:fatal" });
    const [[first], [second]] = seen as [unknown[], unknown[]];
    expect(first).toBe(second);
    const wrapped = first as ReturnType<typeof adapter.fork>;
    expect(wrapped.pid).toBe(4242);
    wrapped.kill("SIGTERM");
    expect(raw.process.kill).toHaveBeenCalledWith("SIGTERM");
    wrapped.send({ type: "aai-start:relay-result", id: 1, outcome: "acked" });
    expect(raw.send).toHaveBeenCalled();
  });

  test("a send to a disconnected worker is dropped, not thrown", () => {
    const adapter = nodeCluster();
    const raw = emittedWorker(false);
    let wrapped: ReturnType<typeof adapter.fork> | undefined;
    adapter.onMessage((worker) => {
      wrapped = worker;
    });
    cluster.emit("message", raw, {});
    wrapped?.send({ type: "aai-start:relay-result", id: 1, outcome: "acked" });
    expect(raw.send).not.toHaveBeenCalled();
  });

  test("an exit is reported with its code and signal", () => {
    const adapter = nodeCluster();
    const exits: unknown[] = [];
    adapter.onExit((worker, code, signal) => exits.push([worker.pid, code, signal]));
    cluster.emit("exit", emittedWorker(), 1, null);
    expect(exits).toEqual([[4242, 1, null]]);
  });
});

describe("processLink", () => {
  function fakeProcess() {
    const emitter = new EventEmitter();
    const sent: WorkerMessage[] = [];
    const proc: IpcProcess = {
      send: (message) => sent.push(message),
      on: (event, listener) => emitter.on(event, listener),
    };
    return { proc, emitter, sent };
  }

  test("sends through the process's IPC channel", () => {
    const { proc, sent } = fakeProcess();
    processLink(proc).send({ type: "aai-start:fatal", message: "x" });
    expect(sent).toEqual([{ type: "aai-start:fatal", message: "x" }]);
  });

  test("passes the protocol's messages on, with a socket handle when one came", () => {
    const { proc, emitter } = fakeProcess();
    const got: unknown[] = [];
    processLink(proc).onMessage((message, socket) => got.push([message, socket]));
    const socket = new Socket();
    emitter.emit(
      "message",
      { type: "aai-start:upgrade", bytes: new Uint8Array(), call: true },
      socket,
    );
    emitter.emit(
      "message",
      { type: "aai-start:relay-result", id: 1, outcome: "acked" },
      "not-a-socket",
    );
    emitter.emit("message", { type: "someone-else" });
    emitter.emit("message", "plain string");
    expect(got).toEqual([
      [{ type: "aai-start:upgrade", bytes: new Uint8Array(), call: true }, socket],
      [{ type: "aai-start:relay-result", id: 1, outcome: "acked" }, undefined],
    ]);
    socket.destroy();
  });

  test("with no IPC channel, sending is a no-op", () => {
    const proc: IpcProcess = { send: undefined, on: () => undefined };
    expect(() => processLink(proc).send({ type: "aai-start:fatal", message: "x" })).not.toThrow();
  });
});
