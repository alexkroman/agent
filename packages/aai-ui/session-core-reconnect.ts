// Copyright 2026 the AAI authors. MIT license.

/**
 * Automatic reconnection for the browser session socket, built on
 * partysocket's `ReconnectingWebSocket`. Kept out of `session-core.ts` so
 * the state machine there reads as protocol logic, not socket plumbing.
 */

import ReconnectingWebSocket from "partysocket/ws";

/**
 * Backoff for automatic reconnects after an unexpected close (partysocket):
 * exponential from 1s, capped at 15s, giving up after 10 attempts. Applies
 * only to the default socket implementation — an injected
 * `options.WebSocket` (tests) never reconnects on its own.
 */
const RECONNECT_OPTIONS = {
  minReconnectionDelay: 1000,
  maxReconnectionDelay: 15_000,
  reconnectionDelayGrowFactor: 2,
  maxRetries: 10,
} as const;

/**
 * Open partysocket's reconnecting WebSocket. The URL is a *provider*,
 * re-evaluated on every attempt, so each retry picks up the current resume
 * URL rather than the one the session started with.
 */
export function openReconnectingSocket(urlProvider: () => string): ReconnectingWebSocket {
  return new ReconnectingWebSocket(urlProvider, undefined, RECONNECT_OPTIONS);
}

/**
 * True while `socket` is a reconnecting socket that will retry after the
 * close event currently being handled. partysocket schedules the retry
 * *before* dispatching `close`, so `retryCount` already names the attempt
 * just scheduled — at `maxRetries` it has given up.
 */
export function reconnectPending(socket: unknown): boolean {
  return (
    socket instanceof ReconnectingWebSocket &&
    socket.shouldReconnect &&
    socket.retryCount < RECONNECT_OPTIONS.maxRetries
  );
}
