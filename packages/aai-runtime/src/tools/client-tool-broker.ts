// Copyright 2026 the AAI authors. MIT license.
/**
 * Where a `clientTool` call waits for the browser — the `tool_result` a page's
 * `useClientTool` sends back, matched to the call by `toolCallId`.
 *
 * The self-hosted twin of `../server/host-relay.ts`, and deliberately narrower: host mode
 * relays EVERY tool and so emits `tool.called` itself, where this sits under the
 * ordinary dispatcher. The session has already emitted `tool.called` (S2S from
 * `../session/tool-steps.ts`, the pipeline from its stream parts) and will emit
 * `tool.completed`, so the broker owns only the wait. The deadline, the turn
 * signal, argument validation and `onError` all stay `executeToolCall`'s, which
 * is why it resolves a VALUE rather than a finished tool result string.
 *
 * One broker per runtime, keyed by session AND call: the dispatcher is
 * runtime-wide and the answer arrives on one session's socket.
 *
 * **An answer can beat its wait.** Neither transport promises the `tool.called`
 * frame leaves after the executor starts, so a result with no waiter is held —
 * briefly and boundedly, since a client can send `tool_result` for any id it
 * likes — and claimed by the wait that arrives for it.
 */

import { safeJsonParse } from "@alexkroman1/aai/utils";

/** An inbound `tool_result`, as the command dispatcher hands it over. */
export type ClientToolAnswer = { toolCallId: string; result: string; error?: string | undefined };

/** The runtime's view of every call waiting on a page. @internal */
export type ClientToolBroker = {
  /** Wait for the page's answer to `toolCallId`; rejects on `signal` or an `error` answer. */
  wait(sessionId: string, toolCallId: string, signal: AbortSignal): Promise<unknown>;
  /** Settle the matching wait, or hold the answer for one that has not started. */
  answer(sessionId: string, message: ClientToolAnswer): void;
};

/**
 * Answers held for a wait that has not started, runtime-wide. A handful is the
 * real case (one reply's parallel calls); the bound is against a client
 * answering ids nothing will ever wait for — a late answer to a call that timed
 * out, or a page answering a server tool — which is also why nothing sweeps
 * them per session: the oldest simply fall off.
 */
const MAX_EARLY_ANSWERS = 64;

const keyOf = (sessionId: string, toolCallId: string): string => `${sessionId}\u0000${toolCallId}`;

/**
 * The value the model gets: the page JSON-encodes its handler's return, so a
 * parse gives it back; a non-JSON string is passed through as sent.
 */
function decode(message: ClientToolAnswer): unknown {
  if (message.error !== undefined) throw new Error(message.error);
  const parsed = safeJsonParse(message.result);
  return parsed === undefined ? message.result : parsed;
}

/** @internal */
export function createClientToolBroker(): ClientToolBroker {
  const waiting = new Map<string, (message: ClientToolAnswer) => void>();
  const early = new Map<string, ClientToolAnswer>();

  function wait(sessionId: string, toolCallId: string, signal: AbortSignal): Promise<unknown> {
    const key = keyOf(sessionId, toolCallId);
    const held = early.get(key);
    if (held) {
      early.delete(key);
      return Promise.resolve().then(() => decode(held));
    }
    if (waiting.has(key)) {
      return Promise.reject(new Error(`clientTool call "${toolCallId}" is already waiting`));
    }
    if (signal.aborted) return Promise.reject(signal.reason);
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const onAbort = (): void => {
      waiting.delete(key);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    waiting.set(key, (message) => {
      waiting.delete(key);
      signal.removeEventListener("abort", onAbort);
      try {
        resolve(decode(message));
      } catch (err: unknown) {
        reject(err);
      }
    });
    return promise;
  }

  function answer(sessionId: string, message: ClientToolAnswer): void {
    const key = keyOf(sessionId, message.toolCallId);
    const settle = waiting.get(key);
    if (settle) {
      settle(message);
      return;
    }
    // A duplicate answer (two pages, two handlers) replaces rather than grows.
    early.delete(key);
    early.set(key, message);
    if (early.size > MAX_EARLY_ANSWERS) {
      const oldest = early.keys().next().value;
      if (oldest !== undefined) early.delete(oldest);
    }
  }

  return { wait, answer };
}
