// Copyright 2025 the AAI authors. MIT license.

import { batch, effect, type Signal, signal, useSignalEffect } from "@preact/signals";
import type { ComponentChildren, JSX, RefObject } from "preact";
import { createContext, h } from "preact";
import { useContext, useEffect, useRef } from "preact/hooks";
import type { VoiceSession } from "./session.ts";
import type { ToolCallInfo } from "./types.ts";

/**
 * Reactive session controls wrapping a {@link VoiceSession} with Preact signals.
 *
 * Components access reactive data via `session` (e.g. `session.state`,
 * `session.messages`). UI-only state (`started`, `running`) and actions
 * (`start`, `toggle`, `reset`) live directly on this object.
 *
 * @public
 */
export type SessionSignals = {
  /** The underlying voice session — all reactive data lives here. */
  session: VoiceSession;
  /** Whether the session has been started by the user. */
  started: Signal<boolean>;
  /** Whether the session is currently running (connected or connecting). */
  running: Signal<boolean>;
  /** Dispose the reactive effect that tracks error state. */
  dispose(): void;
  /** Start the session for the first time (sets `started` and `running`). */
  start(): void;
  /** Toggle between connected and disconnected states. */
  toggle(): void;
  /** Reset the session: clear state and reconnect. */
  reset(): void;
  /** Alias for `dispose` for use with `using`. */
  [Symbol.dispose](): void;
};

/**
 * Wrap a {@link VoiceSession} in Preact signals for reactive UI binding.
 *
 * Creates higher-level controls (start, toggle, reset) on top of the raw
 * session, and automatically sets `running` to `false` when the session
 * enters an error state.
 *
 * @param session - The voice session to wrap.
 * @returns A {@link SessionSignals} object for use in Preact components.
 *
 * @public
 */
export function createSessionControls(session: VoiceSession): SessionSignals {
  const started = signal(false);
  const running = signal(true);

  const dispose = effect(() => {
    if (session.state.value === "error") running.value = false;
  });

  return {
    session,
    started,
    running,
    dispose,
    start() {
      batch(() => {
        started.value = true;
        running.value = true;
      });
      session.connect();
    },
    toggle() {
      if (running.value) {
        session.cancel();
        session.disconnect();
      } else {
        session.connect();
      }
      running.value = !running.value;
    },
    reset() {
      session.reset();
    },
    [Symbol.dispose]() {
      dispose();
    },
  };
}

const Ctx = createContext<SessionSignals | null>(null);

/**
 * Preact context provider that makes session signals available to descendant
 * components via {@link useSession}.
 *
 * @param props - Provider props. `value` is the session signals to provide. `children` are child components that may consume the context.
 * @returns A Preact VNode wrapping children in the session context.
 *
 * @public
 */
export function SessionProvider({
  value,
  children,
}: {
  value: SessionSignals;
  children?: ComponentChildren;
}): JSX.Element {
  return h(Ctx.Provider, { value }, children);
}

/**
 * Hook to access session signals from within a {@link SessionProvider}.
 *
 * @returns The {@link SessionSignals} from the nearest provider.
 * @throws If called outside of a `SessionProvider`.
 *
 * @public
 */
export function useSession(): SessionSignals {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("Hook useSession() requires a SessionProvider");
  return ctx;
}

function tryParseJSON(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function isNewCompletedCall(
  tc: ToolCallInfo,
  seen: Set<string>,
  filterName: string | undefined,
): tc is ToolCallInfo & { result: string } {
  if (tc.status !== "done" || !tc.result) return false;
  if (seen.has(tc.toolCallId)) return false;
  if (filterName && tc.toolName !== filterName) return false;
  return true;
}

/**
 * Hook that fires a callback exactly once for each newly completed tool call.
 *
 * Handles deduplication internally — safe to use with `useState` setters
 * without worrying about duplicates. The `result` argument is the parsed
 * JSON result from the tool (or the raw string if parsing fails).
 *
 * Automatically resets tracking when the session is reset (toolCalls cleared).
 *
 * @example
 * ```tsx
 * // Filter by tool name with a typed result:
 * useToolResult<Recipe>("get_recipe", (result, toolCall) => {
 *   setRecipe(result);
 * });
 *
 * // Receive all tool results (untyped):
 * useToolResult((toolName, result, toolCall) => {
 *   console.log(toolName, result);
 * });
 * ```
 *
 * @public
 */
export function useToolResult<R = unknown>(
  toolName: string,
  callback: (result: R, toolCall: ToolCallInfo) => void,
): void;
/**
 * Hook that fires a callback exactly once for each newly completed tool call.
 *
 * @param callback - Called once per completed tool call with the tool name,
 *   parsed result, and full {@link ToolCallInfo}.
 *
 * @public
 */
export function useToolResult(
  callback: (toolName: string, result: unknown, toolCall: ToolCallInfo) => void,
): void;
export function useToolResult<R = unknown>(
  toolNameOrCallback:
    | string
    | ((toolName: string, result: unknown, toolCall: ToolCallInfo) => void),
  maybeCallback?: (result: R, toolCall: ToolCallInfo) => void,
): void {
  const filterName = typeof toolNameOrCallback === "string" ? toolNameOrCallback : undefined;
  const callback =
    typeof toolNameOrCallback === "function"
      ? toolNameOrCallback
      : (_name: string, result: unknown, tc: ToolCallInfo) => maybeCallback?.(result as R, tc);

  const { session } = useSession();
  const seenRef = useRef(new Set<string>());
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(
    () =>
      effect(() => {
        const toolCalls = session.toolCalls.value;
        if (toolCalls.length === 0) {
          seenRef.current.clear();
          return;
        }
        for (const tc of toolCalls) {
          if (!isNewCompletedCall(tc, seenRef.current, filterName)) continue;
          seenRef.current.add(tc.toolCallId);
          cbRef.current(tc.toolName, tryParseJSON(tc.result), tc);
        }
      }),
    [session],
  );
}

/**
 * Hook that fires a callback when a new tool call starts (status: "pending").
 *
 * Use this to show a loading/skeleton UI immediately when the agent invokes
 * a tool, rather than waiting for the full result. The callback receives the
 * tool name, parsed arguments, and the full {@link ToolCallInfo}.
 *
 * @param callback - Called once per new tool call at start time.
 *
 * @public
 */
export function useToolCallStart(
  callback: (toolName: string, args: Record<string, unknown>, toolCall: ToolCallInfo) => void,
): void {
  const { session } = useSession();
  const seenRef = useRef(new Set<string>());
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(
    () =>
      effect(() => {
        const toolCalls = session.toolCalls.value;
        if (toolCalls.length === 0) {
          seenRef.current.clear();
          return;
        }
        for (const tc of toolCalls) {
          if (seenRef.current.has(tc.toolCallId)) continue;
          seenRef.current.add(tc.toolCallId);
          cbRef.current(tc.toolName, tc.args, tc);
        }
      }),
    [session],
  );
}

/**
 * Hook that fires a callback for each intermediate update pushed by a tool
 * via `ctx.sendUpdate()`.
 *
 * Use this to render progressive/streaming data from a tool before it
 * finishes — e.g. showing a recipe preview card while nutrition data is
 * still loading.
 *
 * The callback fires once per update. The `data` argument is the parsed
 * JSON update (or raw string if parsing fails).
 *
 * @param callback - Called once per intermediate update with the tool name,
 *   parsed data, and full {@link ToolCallInfo}.
 *
 * @public
 */
export function useToolCallUpdate(
  callback: (toolName: string, data: unknown, toolCall: ToolCallInfo) => void,
): void {
  const { session } = useSession();
  const countRef = useRef(new Map<string, number>());
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(
    () =>
      effect(() => {
        const toolCalls = session.toolCalls.value;
        if (toolCalls.length === 0) {
          countRef.current.clear();
          return;
        }
        for (const tc of toolCalls) {
          processNewUpdates(tc, countRef.current, cbRef.current);
        }
      }),
    [session],
  );
}

function processNewUpdates(
  tc: ToolCallInfo,
  seenCounts: Map<string, number>,
  cb: (toolName: string, data: unknown, toolCall: ToolCallInfo) => void,
): void {
  const seen = seenCounts.get(tc.toolCallId) ?? 0;
  if (tc.updates.length <= seen) return;
  for (let i = seen; i < tc.updates.length; i++) {
    const raw = tc.updates[i];
    if (raw !== undefined) cb(tc.toolName, tryParseJSON(raw), tc);
  }
  seenCounts.set(tc.toolCallId, tc.updates.length);
}

/**
 * Auto-scroll a container to the bottom when messages, tool calls,
 * or utterances change. Returns a ref to attach to a sentinel `<div>`
 * at the bottom of the scrollable area.
 *
 * @public
 */
export function useAutoScroll(): RefObject<HTMLDivElement> {
  const { session } = useSession();
  const ref = useRef<HTMLDivElement>(null);

  useSignalEffect(() => {
    // Reading signal values to subscribe to changes (Preact signals pattern)
    // biome-ignore lint/suspicious/noUnusedExpressions: signal subscription
    session.messages.value;
    // biome-ignore lint/suspicious/noUnusedExpressions: signal subscription
    session.toolCalls.value;
    // biome-ignore lint/suspicious/noUnusedExpressions: signal subscription
    session.userUtterance.value;
    // biome-ignore lint/suspicious/noUnusedExpressions: signal subscription
    session.agentUtterance.value;
    ref.current?.scrollIntoView({ behavior: "smooth" });
  });

  return ref;
}
