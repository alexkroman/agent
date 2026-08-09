// Copyright 2026 the AAI authors. MIT license.
/**
 * The host-mode tool relay: tool calls go OUT to the client, results come back.
 *
 * A host-mode caller supplies tool *schemas*, not tool code, so nothing it
 * declares can execute in this process. `createRelayExecuteTool` is what makes
 * that true — it is an {@link ExecuteTool} that emits a `tool_call` frame and
 * waits for the matching inbound `tool_result`, so the model's tool calls are
 * answered by the caller rather than by the server.
 *
 * Split from `host-mode.ts` (which owns the handshake and session start) to
 * keep both under the file-length cap; the two have no shared state.
 */

import pTimeout from "p-timeout";
import type { ExecuteTool } from "../sdk/_internal-types.ts";
import { DEFAULT_RELAY_TOOL_TIMEOUT_MS } from "../sdk/constants.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import type { ClientEvent } from "../sdk/protocol.ts";
import { safeJsonParse, toolError } from "../sdk/utils.ts";

/**
 * The inbound `tool_result` payload routed to {@link RelayExecuteTool.onToolResult}.
 * @internal
 */
export type RelayToolResult = {
  toolCallId: string;
  result: string;
  error?: string | undefined;
};

/**
 * A relay tool executor plus the hooks needed to feed it inbound results.
 * @internal
 */
export type RelayExecuteTool = {
  /** {@link ExecuteTool} that relays each call to the client and awaits a result. */
  executeTool: ExecuteTool;
  /** Resolve (or reject) the pending call matching `toolCallId`. */
  onToolResult(msg: RelayToolResult): void;
  /** Reject every still-pending call (call on connection close). */
  dispose(): void;
};

type ToolCallEvent = Extract<ClientEvent, { type: "tool_call" }>;

/**
 * A relay's `result` field arrives as a string on the wire. Clients commonly
 * JSON-encode their tool output; unwrap a JSON string so the model receives
 * clean text, but leave object/array JSON (and non-JSON) untouched.
 */
function normalizeResult(raw: string): string {
  const parsed = safeJsonParse(raw);
  return typeof parsed === "string" ? parsed : raw;
}

/**
 * Build a relay tool executor: `executeTool` emits a `tool_call` frame via
 * `send` and returns a promise keyed by `toolCallId`; `onToolResult` settles
 * that promise when the client replies. Calls that never receive a result
 * reject after `timeoutMs` (default `DEFAULT_RELAY_TOOL_TIMEOUT_MS`, 120 000 ms).
 *
 * @internal
 */
export function createRelayExecuteTool(opts: {
  send: (event: ToolCallEvent) => void;
  timeoutMs?: number | undefined;
}): RelayExecuteTool {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RELAY_TOOL_TIMEOUT_MS;
  type Pending = {
    resolve: (value: string) => void;
    reject: (reason: Error) => void;
  };
  const pending = new Map<string, Pending>();

  const executeTool: ExecuteTool = (name, args, _sessionId, _messages, callOpts) => {
    const toolCallId = callOpts?.toolCallId;
    if (!toolCallId) {
      // Defensive: every path should thread a toolCallId (see session-core /
      // to-vercel-tools). Without one the result can't be correlated.
      return Promise.resolve(toolError(`Relay tool "${name}" invoked without a toolCallId`));
    }
    if (pending.has(toolCallId)) {
      // A second in-flight call with the same id would clobber the first
      // entry, and the first call's timer would then delete the new entry —
      // dropping its genuine tool_result. Refuse instead of clobbering.
      return Promise.resolve(
        toolError(`Relay tool "${name}" duplicates in-flight toolCallId "${toolCallId}"`),
      );
    }
    const signal = callOpts?.signal;
    if (signal?.aborted) {
      return Promise.resolve(toolError(`Relay tool "${name}" (${toolCallId}) was cancelled`));
    }
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    pending.set(toolCallId, { resolve, reject });
    opts.send({ type: "tool_call", toolCallId, toolName: name, args });
    // p-timeout owns the deadline and the abort listener: it rejects with the
    // timeout Error below, or with the signal's abort reason on cancellation.
    // Either way the pending entry is dropped once the call settles.
    return pTimeout(promise, {
      milliseconds: timeoutMs,
      ...omitUndefined({ signal }),
      message: new Error(`Relay tool "${name}" (${toolCallId}) timed out after ${timeoutMs}ms`),
    }).finally(() => {
      pending.delete(toolCallId);
    });
  };

  function onToolResult(msg: RelayToolResult): void {
    const entry = pending.get(msg.toolCallId);
    if (!entry) return;
    pending.delete(msg.toolCallId);
    if (msg.error !== undefined) {
      entry.reject(new Error(msg.error));
      return;
    }
    entry.resolve(normalizeResult(msg.result));
  }

  function dispose(): void {
    for (const [, entry] of pending) {
      entry.reject(new Error("Relay disposed before tool result arrived"));
    }
    pending.clear();
  }

  return { executeTool, onToolResult, dispose };
}
