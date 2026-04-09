// Copyright 2025 the AAI authors. MIT license.

import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";

export type RpcMessage = { type: string; [key: string]: unknown };
export type RpcResponse = { id: string; [key: string]: unknown };

type PendingRequest = {
  resolve: (value: RpcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RequestOptions = {
  timeout?: number;
};

export type RpcChannel = ReturnType<typeof createRpcChannel>;

const DEFAULT_TIMEOUT = 30_000;

export function createRpcChannel(stream: Duplex) {
  let idCounter = 0;
  const pending = new Map<string, PendingRequest>();
  const handlers = new Map<string, (msg: RpcMessage & { id: string }) => Promise<unknown>>();

  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  function rejectAll(err: Error): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  }

  function handleResponse(id: string, msg: Record<string, unknown>): boolean {
    const entry = pending.get(id);
    if (entry === undefined) return false;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(msg as RpcResponse);
    return true;
  }

  function handleIncomingRequest(id: string, msg: Record<string, unknown>): void {
    const type = typeof msg.type === "string" ? msg.type : undefined;
    if (type === undefined) return;
    const handler = handlers.get(type);
    if (handler === undefined) return;
    // Fire-and-forget — keep read loop non-blocking
    void handler(msg as RpcMessage & { id: string }).then((result) => {
      const response = { id, ...(result as Record<string, unknown>) };
      stream.write(`${JSON.stringify(response)}\n`);
    });
  }

  function handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      // Silently ignore malformed JSON
      return;
    }

    const id = typeof msg.id === "string" ? msg.id : undefined;
    if (id === undefined) return;

    if (!handleResponse(id, msg)) {
      handleIncomingRequest(id, msg);
    }
  }

  rl.on("line", handleLine);

  stream.on("close", () => {
    rejectAll(new Error("Connection closed"));
    rl.close();
  });

  stream.on("error", () => {
    rejectAll(new Error("Connection closed"));
    rl.close();
  });

  function request(msg: RpcMessage, opts: RequestOptions = {}): Promise<RpcResponse> {
    const id = `h:${++idCounter}`;
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT;

    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC timeout after ${timeout}ms: ${msg.type}`));
      }, timeout);

      pending.set(id, { resolve, reject, timer });
      stream.write(`${JSON.stringify({ ...msg, id })}\n`);
    });
  }

  function onRequest(
    type: string,
    handler: (msg: RpcMessage & { id: string }) => Promise<unknown>,
  ): void {
    handlers.set(type, handler);
  }

  function notify(msg: RpcMessage): void {
    stream.write(`${JSON.stringify(msg)}\n`);
  }

  function close(): void {
    rejectAll(new Error("Connection closed"));
    rl.close();
    stream.destroy();
  }

  return { request, onRequest, notify, close };
}
