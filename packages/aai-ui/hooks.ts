// Copyright 2025 the AAI authors. MIT license.

import { useEffect, useRef } from "react";
import { tryParseJSON } from "./_utils.ts";
import { useSessionSelector } from "./context.ts";
import type { ToolCallInfo } from "./types.ts";

type ToolCallCallback = (...args: unknown[]) => void;

/**
 * Per-hook-instance dedup state for tool-call processing.
 *
 * `seq` is a watermark: every tool call with `seq <= watermark` has been fully
 * processed and is never rescanned. `fired` holds the (small, transient) set
 * of call IDs that were processed *ahead* of the watermark — e.g. a later tool
 * call that completed while an earlier one is still pending — and is pruned as
 * the watermark advances past them. This keeps both scan cost and memory
 * bounded by the unprocessed tail instead of the whole capped array.
 */
type ToolCallCursor = { seq: number; fired: Set<string> };

/** Index of the first item whose sequence number is above the watermark (tail scan from the end). */
function tailStart<T>(items: readonly T[], seqOf: (item: T) => number, watermark: number): number {
  let start = items.length;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item || seqOf(item) <= watermark) break;
    start = i;
  }
  return start;
}

/**
 * Process the unprocessed tail of `toolCalls`: fire `onNew` once per item that
 * has settled (per `isSettled`), then advance the watermark past the leading
 * run of settled items. Resets the cursor when the list is empty (session
 * reset), matching the previous seen-set behavior.
 */
function processToolCallTail(
  toolCalls: readonly ToolCallInfo[],
  cursor: ToolCallCursor,
  isSettled: (tc: ToolCallInfo) => boolean,
  onNew: (tc: ToolCallInfo) => void,
): void {
  if (toolCalls.length === 0) {
    cursor.seq = 0;
    cursor.fired.clear();
    return;
  }
  const start = tailStart(toolCalls, (tc) => tc.seq, cursor.seq);
  for (let i = start; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (!(tc && isSettled(tc)) || cursor.fired.has(tc.callId)) continue;
    cursor.fired.add(tc.callId);
    onNew(tc);
  }
  for (let i = start; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (!(tc && isSettled(tc))) break;
    cursor.fired.delete(tc.callId);
    cursor.seq = tc.seq;
  }
}

/**
 * Shared scaffold for the tool-call lifecycle hooks: parses the optional
 * `(toolName, callback)` / `(callback)` overload args, dedups by call ID,
 * and invokes `fire` once per tool call reaching `status`.
 */
function useToolCallEffect(
  status: ToolCallInfo["status"],
  args: unknown[],
  fire: (callback: ToolCallCallback, toolCall: ToolCallInfo, filtered: boolean) => void,
): void {
  const filterName = typeof args[0] === "string" ? (args[0] as string) : null;
  const callback = (typeof args[0] === "string" ? args[1] : args[0]) as ToolCallCallback;

  const toolCalls = useSessionSelector((s) => s.toolCalls);
  const cursorRef = useRef<ToolCallCursor>({ seq: 0, fired: new Set<string>() });
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const fireRef = useRef(fire);
  fireRef.current = fire;

  useEffect(() => {
    processToolCallTail(
      toolCalls,
      cursorRef.current,
      // Every tool call is born "pending", so for the start hook insertion
      // itself settles the item; the done hook must wait for completion.
      (tc) => status === "pending" || tc.status === status,
      (tc) => {
        if (tc.status !== status) return;
        if (filterName && tc.name !== filterName) return;
        fireRef.current(callbackRef.current, tc, filterName !== null);
      },
    );
  }, [toolCalls, filterName, status]);
}

export function useToolResult<R = unknown>(
  toolName: string,
  callback: (result: R, toolCall: ToolCallInfo) => void,
): void;
export function useToolResult(
  callback: (name: string, result: unknown, toolCall: ToolCallInfo) => void,
): void;
export function useToolResult(...args: unknown[]): void {
  useToolCallEffect("done", args, (callback, tc, filtered) => {
    const parsed = tryParseJSON(tc.result);
    if (filtered) {
      (callback as (r: unknown, tc: ToolCallInfo) => void)(parsed, tc);
    } else {
      (callback as (n: string, r: unknown, tc: ToolCallInfo) => void)(tc.name, parsed, tc);
    }
  });
}

export function useEvent<T = unknown>(event: string, callback: (data: T) => void): void {
  const customEvents = useSessionSelector((s) => s.customEvents);
  // Watermark over the monotonic event `id`: only the tail with id above it
  // is scanned, and no per-event memory accumulates in long sessions.
  const watermarkRef = useRef(0);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (customEvents.length === 0) {
      watermarkRef.current = 0;
      return;
    }
    const start = tailStart(customEvents, (ce) => ce.id, watermarkRef.current);
    for (let i = start; i < customEvents.length; i++) {
      const ce = customEvents[i];
      if (!ce) continue;
      watermarkRef.current = ce.id;
      if (ce.event === event) callbackRef.current(ce.data as T);
    }
  }, [customEvents, event]);
}

export function useToolCallStart(
  toolName: string,
  callback: (toolCall: ToolCallInfo) => void,
): void;
export function useToolCallStart(callback: (toolCall: ToolCallInfo) => void): void;
export function useToolCallStart(...args: unknown[]): void {
  useToolCallEffect("pending", args, (callback, tc) => {
    (callback as (tc: ToolCallInfo) => void)(tc);
  });
}
