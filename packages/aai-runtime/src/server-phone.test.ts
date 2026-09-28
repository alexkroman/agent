// Copyright 2026 the AAI authors. MIT license.
/**
 * `?phone=` on a voice socket as `createRuntimeServer` serves it: normalized to
 * E.164 and handed to the session, or dropped with one warning that does not
 * carry the number.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { silentLogger } from "./_test-utils.ts";
import { type AgentServer, createRuntimeServer, type SessionRuntime } from "./server.ts";

let server: AgentServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start() {
  const starts: { clientPhone?: string | undefined }[] = [];
  const warn = vi.fn();
  const runtime: SessionRuntime = {
    startSession: (_ws, opts) => {
      starts.push({ clientPhone: opts?.clientPhone });
    },
    shutdown: async () => undefined,
  };
  server = createRuntimeServer({ runtime, logger: { ...silentLogger, warn } });
  await server.listen(0);
  return { base: `ws://127.0.0.1:${server.port}`, starts, warn };
}

async function connect(url: string): Promise<void> {
  const ws = new WebSocket(url);
  await new Promise((resolve) => ws.once("open", resolve));
  ws.terminate();
}

describe("?phone= on createRuntimeServer", () => {
  test("a formatted + number reaches the session as E.164", async () => {
    const { base, starts, warn } = await start();
    await connect(`${base}/websocket?phone=${encodeURIComponent("+1 (503) 555-0123")}`);
    await vi.waitFor(() => expect(starts).toEqual([{ clientPhone: "+15035550123" }]));
    expect(warn).not.toHaveBeenCalled();
  });

  test("a number without its + is dropped, with one warning that omits it", async () => {
    const { base, starts, warn } = await start();
    await connect(`${base}/websocket?phone=5035550123`);
    await vi.waitFor(() => expect(starts).toEqual([{ clientPhone: undefined }]));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("5035550123");
  });
});
