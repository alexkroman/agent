// Copyright 2025 the AAI authors. MIT license.

import { useEffect, useRef } from "react";
import { tryParseJSON } from "./_utils.ts";
import { useSession } from "./context.ts";
import type { ToolCallInfo } from "./types.ts";

type ToolCallCallback = (...args: unknown[]) => void;

/**
 * Shared dedup loop: fires `onNew` once per item that passes `shouldProcess`.
 * Clears seen IDs when the list is empty (session reset).
 */
function processNewItems<T, Id>(
  items: readonly T[],
  seen: Set<Id>,
  getId: (item: T) => Id,
  shouldProcess: (item: T) => boolean,
  onNew: (item: T) => void,
): void {
  if (items.length === 0) {
    seen.clear();
    return;
  }
  for (const item of items) {
    if (!shouldProcess(item)) continue;
    const id = getId(item);
    if (seen.has(id)) continue;
    seen.add(id);
    onNew(item);
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

  const session = useSession();
  const seenRef = useRef(new Set<string>());
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const fireRef = useRef(fire);
  fireRef.current = fire;

  useEffect(() => {
    processNewItems(
      session.toolCalls,
      seenRef.current,
      (tc) => tc.callId,
      (tc) => tc.status === status && (!filterName || tc.name === filterName),
      (tc) => fireRef.current(callbackRef.current, tc, filterName !== null),
    );
  }, [session.toolCalls, filterName, status]);
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
  const session = useSession();
  const seenRef = useRef(new Set<number>());
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    processNewItems(
      session.customEvents,
      seenRef.current,
      (ce) => ce.id,
      (ce) => ce.event === event,
      (ce) => callbackRef.current(ce.data as T),
    );
  }, [session.customEvents, event]);
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
