// Copyright 2026 the AAI authors. MIT license.
/**
 * The page's half of a `clientTool`: run the handler when the agent calls the
 * tool, and send what it returned back as the call's result.
 *
 * Built on {@link useToolCallStart}, so it inherits that hook's dedup — one run
 * per `toolCallId` per mounted hook — and its mount rule: a call still PENDING
 * when the hook mounts is run (the server may be waiting on it, e.g. across a
 * resume), a call that already completed is history and is not.
 *
 * @module
 */

import { useRef } from "react";
import { useSessionCore } from "./context.ts";
import { useToolCallStart } from "./hooks.ts";
import type { ToolCallInfo } from "./types.ts";

/**
 * Run a `clientTool` in this page and answer the agent with its result.
 *
 * When the model calls the tool named `toolName`, `handler` runs with the
 * call's arguments. What it returns (or resolves to) is JSON-serialized and
 * becomes the tool's result — the value the model reads. A handler that throws
 * or rejects fails the call, and the model is told the error's message, as it
 * would be for a server tool.
 *
 * The server waits only as long as the tool's `timeoutMs` (default 30 s); an
 * answer after that, or while disconnected, is dropped. Mount the hook once per
 * tool: two mounted handlers both run, and only the first answer counts.
 *
 * @example Let the agent ask for the caller's location
 * ```tsx
 * import { useClientTool } from "@alexkroman1/aai-ui";
 *
 * function LocationTool() {
 *   useClientTool("get_location", () =>
 *     new Promise((resolve, reject) =>
 *       navigator.geolocation.getCurrentPosition(
 *         (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
 *         (err) => reject(new Error(err.message)),
 *       ),
 *     ),
 *   );
 *   return null;
 * }
 * ```
 *
 * @typeParam A - The tool's argument shape. Name it, or derive it with a
 *   TYPE-ONLY import of the server tool: `useClientTool<InferToolInput<typeof
 *   getLocation>>(…)`.
 * @param toolName - The name of the `clientTool` — its `tools/<name>.ts` file.
 * @param handler - Runs the call; its return value is the result.
 *
 * @public
 */
export function useClientTool<A = ToolCallInfo["args"]>(
  toolName: string,
  handler: (args: A, toolCall: ToolCallInfo) => unknown,
): void {
  const core = useSessionCore();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useToolCallStart(toolName, (toolCall) => {
    // `Promise.try` would read better; `then` keeps a sync throw a rejection too.
    void Promise.resolve()
      .then(() => handlerRef.current(toolCall.args as A, toolCall))
      .then(
        (result) => core.sendToolResult(toolCall.callId, { result }),
        (err: unknown) =>
          core.sendToolResult(toolCall.callId, {
            error: err instanceof Error ? err.message : String(err),
          }),
      );
  });
}
