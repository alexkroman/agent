// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared header-capable WebSocket adapter contract for provider transports
 * that authenticate via custom headers (AssemblyAI S2S, OpenAI Realtime).
 */

import WsWebSocket from "ws";

export type HeaderWebSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
};

export type CreateHeaderWebSocket = (
  url: string,
  opts: { headers: Record<string, string> },
) => HeaderWebSocket;

// Node's native WebSocket doesn't support custom headers; the `ws` package does.
export const defaultCreateHeaderWebSocket: CreateHeaderWebSocket = (url, opts) =>
  new WsWebSocket(url, { headers: opts.headers }) as unknown as HeaderWebSocket;
