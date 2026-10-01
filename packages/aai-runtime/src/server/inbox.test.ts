// Copyright 2026 the AAI authors. MIT license.
/**
 * `WS /inbox` as `createServerForRuntime` serves it: the route, the published step
 * slot a run's `stepNotifyClient` goes through, the session gate in front of it,
 * and `?client=` on a voice socket reaching `sessionClientId`.
 */

import { sessionClientId } from "@alexkroman1/aai";
import { stepNotifyClient } from "@alexkroman1/aai/step";
import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { silentLogger } from "../_logger-test-utils.ts";
import { type AgentServer, createServerForRuntime, type SessionRuntime } from "./server.ts";
import { createSessionAuth, SESSION_UNAUTHORIZED_CLOSE_CODE } from "./session-auth.ts";

let server: AgentServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(options: Partial<Parameters<typeof createServerForRuntime>[0]> = {}) {
  const starts: { clientId?: string | undefined }[] = [];
  const runtime: SessionRuntime = {
    startSession: (_ws, opts) => {
      starts.push({ clientId: opts?.clientId });
    },
    shutdown: async () => undefined,
  };
  server = createServerForRuntime({ runtime, logger: silentLogger, ...options });
  await server.listen(0);
  return { base: `ws://127.0.0.1:${server.port}`, starts };
}

describe("WS /inbox on createServerForRuntime", () => {
  test("a step's stepNotifyClient reaches the device connected under that id", async () => {
    const { base } = await start();
    const device = new WebSocket(`${base}/inbox?client=speaker`);
    const received: unknown[] = [];
    device.on("message", (data, isBinary) => {
      if (isBinary) return;
      const notice = JSON.parse(String(data));
      received.push(notice);
      device.send(JSON.stringify({ type: "ack", id: notice.id }));
    });
    await new Promise((resolve) => device.once("open", resolve));
    // The socket is adopted a tick after `open`; the step retries in real life.
    await vi.waitFor(() => stepNotifyClient("speaker", { id: "run-1", event: "reminder" }));
    expect(received).toEqual([
      expect.objectContaining({ type: "notice", id: "run-1", event: "reminder" }),
    ]);
    device.terminate();
  });

  test("the inbox is behind the session gate", async () => {
    const { base } = await start({ auth: createSessionAuth({ secret: "x".repeat(32) }) });
    const device = new WebSocket(`${base}/inbox?client=speaker`);
    const code = await new Promise<number>((resolve) => device.once("close", resolve));
    expect(code).toBe(SESSION_UNAUTHORIZED_CLOSE_CODE);
  });

  test("?client= on a voice socket is handed to the session", async () => {
    const { base, starts } = await start();
    const ws = new WebSocket(`${base}/websocket?client=kitchen`);
    await new Promise((resolve) => ws.once("open", resolve));
    await vi.waitFor(() => expect(starts).toEqual([{ clientId: "kitchen" }]));
    ws.terminate();
  });
});

describe("sessionClientId", () => {
  test("is exported where a tool reads it", () => {
    expect(sessionClientId({ sessionId: "never-recorded" })).toBeUndefined();
  });
});
