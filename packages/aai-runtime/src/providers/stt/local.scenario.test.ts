// Copyright 2026 the AAI authors. MIT license.
/** Scenario test: the local-model STT opener against a loopback server. */

import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { type WebSocket as ServerSocket, WebSocketServer } from "ws";
import { openLocalStt } from "./local.ts";

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function startServer(): Promise<{
  url: string;
  received: Array<string | Buffer>;
  headers: Record<string, string | string[] | undefined>[];
  client: Promise<ServerSocket>;
}> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const received: Array<string | Buffer> = [];
  const headers: Record<string, string | string[] | undefined>[] = [];
  const client = new Promise<ServerSocket>((resolve) => {
    wss.on("connection", (ws, req) => {
      headers.push(req.headers);
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        received.push(isBinary ? data : data.toString());
      });
      resolve(ws);
    });
  });
  cleanup = async () => {
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  };
  const { port } = wss.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}`, received, headers, client };
}

const until = (cond: () => boolean): Promise<void> =>
  vi.waitFor(() => {
    if (!cond()) throw new Error("condition not yet met");
  });

test("sends config then audio, and forwards the server's partial and final", async () => {
  const server = await startServer();
  const session = await openLocalStt({ url: server.url }).open({
    sampleRate: 16_000,
    apiKey: "",
    signal: new AbortController().signal,
  });
  const partials: string[] = [];
  const finals: string[] = [];
  session.on("partial", (t) => partials.push(t));
  session.on("final", (t) => finals.push(t));

  const ws = await server.client;
  session.sendAudio(new Int16Array([1, 2, 3]));
  session.updateEndpointing?.(400);
  session.forceEndOfTurn?.();
  await until(() => server.received.length >= 4);

  expect(JSON.parse(server.received[0] as string)).toMatchObject({
    type: "config",
    sample_rate: 16_000,
  });
  expect((server.received[1] as Buffer).byteLength).toBe(6);
  expect(JSON.parse(server.received[2] as string)).toEqual({
    type: "update",
    min_turn_silence_ms: 400,
  });
  expect(JSON.parse(server.received[3] as string)).toEqual({ type: "force_endpoint" });
  expect(server.headers[0]?.authorization).toBeUndefined();

  ws.send(JSON.stringify({ type: "partial", text: "change my" }));
  ws.send(JSON.stringify({ type: "final", text: "Change my address.", end_of_turn_confidence: 1 }));
  await until(() => finals.length > 0);
  expect(partials).toEqual(["change my"]);
  expect(finals).toEqual(["Change my address."]);
  await session.close();
});

test("a server that closes mid-call is a stream error, not a silent deafness", async () => {
  const server = await startServer();
  const session = await openLocalStt({ url: server.url }).open({
    sampleRate: 16_000,
    apiKey: "secret",
    signal: new AbortController().signal,
  });
  const errors: string[] = [];
  session.on("error", (e) => errors.push(e.code));
  const ws = await server.client;
  expect(server.headers[0]?.authorization).toBe("Bearer secret");
  ws.close(1000);
  await until(() => errors.length > 0);
  expect(errors).toEqual(["stt_stream_error"]);
});
