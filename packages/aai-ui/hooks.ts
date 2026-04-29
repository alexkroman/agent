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

function useToolCallEffect(
  filterStatus: ToolCallInfo["status"],
  filterName: string | null,
  onNew: (tc: ToolCallInfo) => void,
): void {
  const session = useSession();
  const seenRef = useRef(new Set<string>());
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;

  useEffect(() => {
    const seen = seenRef.current;
    if (session.toolCalls.length === 0) {
      seen.clear();
      return;
    }
    for (const tc of session.toolCalls) {
      if (tc.status !== filterStatus) continue;
      if (filterName && tc.name !== filterName) continue;
      if (seen.has(tc.callId)) continue;
      seen.add(tc.callId);
      onNewRef.current(tc);
    }
  }, [session.toolCalls, filterStatus, filterName]);
}

export function useToolResult<R = unknown>(
  toolName: string,
  callback: (result: R, toolCall: ToolCallInfo) => void,
): void;
export function useToolResult(
  callback: (name: string, result: unknown, toolCall: ToolCallInfo) => void,
): void;
export function useToolResult(...args: unknown[]): void {
  const filterName = typeof args[0] === "string" ? args[0] : null;
  const callback = (typeof args[0] === "string" ? args[1] : args[0]) as (
    ...cbArgs: unknown[]
  ) => void;

  useToolCallEffect("done", filterName, (tc) => {
    const parsed = tryParseJSON(tc.result);
    if (filterName) {
      callback(parsed, tc);
    } else {
      callback(tc.name, parsed, tc);
    }
  });
}

export function useToolCallStart(
  toolName: string,
  callback: (toolCall: ToolCallInfo) => void,
): void;
export function useToolCallStart(callback: (toolCall: ToolCallInfo) => void): void;
export function useToolCallStart(...args: unknown[]): void {
  const filterName = typeof args[0] === "string" ? args[0] : null;
  const callback = (typeof args[0] === "string" ? args[1] : args[0]) as (tc: ToolCallInfo) => void;

  useToolCallEffect("pending", filterName, callback);
}

export function useEvent<T = unknown>(event: string, callback: (data: T) => void): void {
  const session = useSession();
  const seenRef = useRef(new Set<number>());
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const seen = seenRef.current;
    if (session.customEvents.length === 0) {
      seen.clear();
      return;
    }
    for (const ce of session.customEvents) {
      if (ce.event !== event) continue;
      if (seen.has(ce.id)) continue;
      seen.add(ce.id);
      callbackRef.current(ce.data as T);
    }
  }, [session.customEvents, event]);
}
