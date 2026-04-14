// Copyright 2025 the AAI authors. MIT license.

import { useEffect, useRef } from "react";
import { useSession } from "./context.ts";
import type { ToolCallInfo } from "./types.ts";

function tryParseJSON(str: string | undefined): unknown {
  if (!str) return str;
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

type ToolCallCallback = (...args: unknown[]) => void;

/**
 * Shared effect loop: fires `onNew` once per tool call that passes `shouldProcess`.
 * Clears seen IDs when toolCalls is empty (session reset).
 */
function processToolCalls(
  toolCalls: ToolCallInfo[],
  seen: Set<string>,
  shouldProcess: (tc: ToolCallInfo) => boolean,
  onNew: (tc: ToolCallInfo) => void,
): void {
  if (toolCalls.length === 0) {
    seen.clear();
    return;
  }
  for (const tc of toolCalls) {
    if (!shouldProcess(tc)) continue;
    if (seen.has(tc.callId)) continue;
    seen.add(tc.callId);
    onNew(tc);
  }
}

export function useToolResult<R = unknown>(
  toolName: string,
  callback: (result: R, toolCall: ToolCallInfo) => void,
): void;
export function useToolResult(
  callback: (name: string, result: unknown, toolCall: ToolCallInfo) => void,
): void;
export function useToolResult(...args: unknown[]): void {
  const filterName = typeof args[0] === "string" ? (args[0] as string) : null;
  const callback = (typeof args[0] === "string" ? args[1] : args[0]) as ToolCallCallback;

  const session = useSession();
  const seenRef = useRef(new Set<string>());
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    processToolCalls(
      session.toolCalls,
      seenRef.current,
      (tc) => tc.status === "done" && (!filterName || tc.name === filterName),
      (tc) => {
        const parsed = tryParseJSON(tc.result);
        if (filterName) {
          (callbackRef.current as (r: unknown, tc: ToolCallInfo) => void)(parsed, tc);
        } else {
          (callbackRef.current as (n: string, r: unknown, tc: ToolCallInfo) => void)(
            tc.name,
            parsed,
            tc,
          );
        }
      },
    );
  }, [session.toolCalls, filterName]);
}

export function useEvent<T = unknown>(event: string, callback: (data: T) => void): void {
  const session = useSession();
  const seenRef = useRef(new Set<number>());
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (session.customEvents.length === 0) {
      seenRef.current.clear();
      return;
    }
    for (const ce of session.customEvents) {
      if (ce.event !== event) continue;
      if (seenRef.current.has(ce.id)) continue;
      seenRef.current.add(ce.id);
      callbackRef.current(ce.data as T);
    }
  }, [session.customEvents, event]);
}

export function useToolCallStart(
  toolName: string,
  callback: (toolCall: ToolCallInfo) => void,
): void;
export function useToolCallStart(callback: (toolCall: ToolCallInfo) => void): void;
export function useToolCallStart(...args: unknown[]): void {
  const filterName = typeof args[0] === "string" ? (args[0] as string) : null;
  const callback = (typeof args[0] === "string" ? args[1] : args[0]) as ToolCallCallback;

  const session = useSession();
  const seenRef = useRef(new Set<string>());
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    processToolCalls(
      session.toolCalls,
      seenRef.current,
      (tc) => tc.status === "pending" && (!filterName || tc.name === filterName),
      (tc) => (callbackRef.current as (tc: ToolCallInfo) => void)(tc),
    );
  }, [session.toolCalls, filterName]);
}
