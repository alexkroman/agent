// Copyright 2026 the AAI authors. MIT license.
/**
 * `createHostServer` — the multi-tenant host server.
 *
 * These drive a real listening server over a real WebSocket rather than
 * asserting on the options handed to `createServer`: every property worth
 * having here is a property of the wire, and an options-shape assertion would
 * pass just as happily against a server that never worked.
 *
 * Every case settles BEFORE a runtime is built, so none of them touch the
 * network. A handshake that succeeds would open real STT/TTS sockets (~500ms
 * of retries against a fake key), which does not belong in the unit tier —
 * that a caller's credential reaches provider resolution is asserted on the
 * captured `RuntimeOptions` in `host-mode.test.ts` instead. The distinction
 * that matters here is WHICH rejection arrives: "host mode is not enabled"
 * means the gate is shut, while a missing-key error means the gate is open and
 * the handshake got all the way to building a session.
 */

import { afterEach, describe, expect, test } from "vitest";
import { silentLogger, withDeadline } from "./_test-utils.ts";
import { createHostServer } from "./host-server.ts";

type Frame = Record<string, unknown>;

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function startServer(options: Parameters<typeof createHostServer>[0] = {}): Promise<number> {
  const server = createHostServer({ logger: silentLogger, ...options });
  servers.push(server);
  await server.listen(0);
  return server.port as number;
}

/**
 * Connect, optionally handshake, and collect JSON frames until the socket
 * settles. Resolves on `error` too: a connection the `upgrade` hook destroys
 * never completes its handshake, so it never reaches `close`.
 *
 * DEADLINED, because this file's whole premise is that a rejected handshake
 * writes a frame *and closes*. A change that reports the error and leaves the
 * socket open satisfies neither listener, and without a deadline all five
 * tests become 5 s tier timeouts naming the file and no assertion. The failure
 * now says which socket never settled and what it had received by then.
 */
function connect(port: number, opts: { host?: boolean; frame?: Frame } = {}): Promise<Frame[]> {
  const query = opts.host === false ? "" : "?host=1";
  const ws = new WebSocket(`ws://127.0.0.1:${port}/websocket${query}`);
  const frames: Frame[] = [];
  const settled = new Promise<Frame[]>((resolve) => {
    const done = (): void => resolve(frames);
    ws.addEventListener("open", () => {
      if (opts.frame) ws.send(JSON.stringify(opts.frame));
    });
    ws.addEventListener("message", (e: MessageEvent) => {
      if (typeof e.data === "string") frames.push(JSON.parse(e.data) as Frame);
    });
    ws.addEventListener("close", done);
    ws.addEventListener("error", done);
  });
  return withDeadline(
    settled,
    () => `socket never closed or errored (frames so far: ${JSON.stringify(frames)})`,
  ).finally(() => ws.close());
}

function handshake(host: Frame = {}): Frame {
  return { type: "config", host: { systemPrompt: "You are a tenant agent.", tools: [], ...host } };
}

const GATE_SHUT = "host mode is not enabled";

describe("createHostServer", () => {
  test("host mode is on without the caller setting AAI_ALLOW_HOST", async () => {
    // The whole point of the wrapper: the same call to `createServer` needs an
    // explicit env flag, and forgetting it rejects every connection.
    const frames = await connect(await startServer(), { frame: handshake() });

    expect(frames).not.toContainEqual(
      expect.objectContaining({ message: expect.stringContaining(GATE_SHUT) }),
    );
    // Past the gate and into session construction, which is as far as a
    // credential-less caller can get on a server that holds no key either.
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "error.reported",
        code: "protocol",
        message: expect.stringContaining("ASSEMBLYAI_API_KEY"),
      }),
    );
  });

  test("an AAI_ALLOW_HOST of 0 in env cannot disable the server's only function", async () => {
    const port = await startServer({ env: { AAI_ALLOW_HOST: "0" } });
    const frames = await connect(port, { frame: handshake() });

    expect(frames).not.toContainEqual(
      expect.objectContaining({ message: expect.stringContaining(GATE_SHUT) }),
    );
  });

  test("a plain (non-host) session is declined rather than left hanging", async () => {
    const frames = await connect(await startServer(), { host: false });

    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "error.reported",
        code: "protocol",
        message: expect.stringContaining("?host=1"),
      }),
    );
  });

  test("a non-provider credential name rejects the handshake, naming it", async () => {
    const port = await startServer();
    const frames = await connect(port, {
      frame: handshake({ credentials: { DATABASE_URL: "postgres://attacker" } }),
    });

    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "error.reported",
        code: "protocol",
        message: expect.stringContaining("DATABASE_URL"),
      }),
    );
  });

  test("the upgrade hook can reject a connection before the handshake runs", async () => {
    const port = await startServer({
      upgrade(req, socket) {
        if (req.headers.authorization === "Bearer ok") return false;
        socket.destroy();
        return true;
      },
    });

    // No frames at all: the socket dies at the upgrade, so the handshake
    // listener is never attached and no rejection is ever written.
    expect(await connect(port, { frame: handshake() })).toEqual([]);
  });
});
