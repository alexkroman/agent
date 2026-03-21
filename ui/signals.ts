// Copyright 2025 the AAI authors. MIT license.

import { batch, effect, type Signal, signal, useSignalEffect } from "@preact/signals";
import type * as preact from "preact";
import type { ComponentChildren, RefObject } from "preact";
import { createContext, h } from "preact";
import { useContext, useEffect, useRef } from "preact/hooks";
import type { VoiceSession } from "./session.ts";
import type { ToolCallInfo } from "./types.ts";

/**
 * Reactive session controls wrapping a {@linkcode VoiceSession} with Preact signals.
 *
 * Components access reactive data via `session` (e.g. `session.state`,
 * `session.messages`). UI-only state (`started`, `running`) and actions
 * (`start`, `toggle`, `reset`) live directly on this object.
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
  /** Alias for {@linkcode dispose} for use with `using`. */
  [Symbol.dispose](): void;
};

/**
 * Wrap a {@linkcode VoiceSession} in Preact signals for reactive UI binding.
 *
 * Creates higher-level controls (start, toggle, reset) on top of the raw
 * session, and automatically sets `running` to `false` when the session
 * enters an error state.
 *
 * @param session - The voice session to wrap.
 * @returns A {@linkcode SessionSignals} object for use in Preact components.
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
 * components via {@linkcode useSession}.
 *
 * @param props - Provider props.
 * @param props.value - The session signals to provide.
 * @param props.children - Child components that may consume the context.
 * @returns A Preact VNode wrapping children in the session context.
 */
export function SessionProvider({
  value,
  children,
}: {
  value: SessionSignals;
  children?: ComponentChildren;
}): preact.JSX.Element {
  return h(Ctx.Provider, { value }, children);
}

/**
 * Hook to access session signals from within a {@linkcode SessionProvider}.
 *
 * @returns The {@linkcode SessionSignals} from the nearest provider.
 * @throws {Error} If called outside of a `SessionProvider`.
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

/**
 * Hook that fires a callback exactly once for each newly completed tool call.
 *
 * Handles deduplication internally — safe to use with `useState` setters
 * without worrying about duplicates. The `result` argument is the parsed
 * JSON result from the tool (or the raw string if parsing fails).
 *
 * Automatically resets tracking when the session is reset (toolCalls cleared).
 *
 * @param callback - Called once per completed tool call with the tool name,
 *   parsed result, and full {@linkcode ToolCallInfo}.
 */
export function useToolResult(
  callback: (toolName: string, result: unknown, toolCall: ToolCallInfo) => void,
): void {
  const { session } = useSession();
  const seenRef = useRef(new Set<string>());
  const cbRef = useRef(callback);
  cbRef.current = callback;
  const disposeRef = useRef<(() => void) | null>(null);

  if (!disposeRef.current) {
    disposeRef.current = effect(() => {
      const toolCalls = session.toolCalls.value;
      if (toolCalls.length === 0) {
        seenRef.current.clear();
        return;
      }
      for (const tc of toolCalls) {
        if (tc.status !== "done" || !tc.result) continue;
        if (seenRef.current.has(tc.toolCallId)) continue;
        seenRef.current.add(tc.toolCallId);
        const parsed = tryParseJSON(tc.result);
        cbRef.current(tc.toolName, parsed, tc);
      }
    });
  }

  useEffect(
    () => () => {
      disposeRef.current?.();
      disposeRef.current = null;
    },
    [],
  );
}

/**
 * Auto-scroll a container to the bottom when messages, tool calls,
 * or utterances change. Returns a ref to attach to a sentinel `<div>`
 * at the bottom of the scrollable area.
 */
export function useAutoScroll(): RefObject<HTMLDivElement | null> {
  const { session } = useSession();
  const ref = useRef<HTMLDivElement | null>(null);

  useSignalEffect(() => {
    session.messages.value;
    session.toolCalls.value;
    session.userUtterance.value;
    session.agentUtterance.value;
    ref.current?.scrollIntoView({ behavior: "smooth" });
  });

  return ref;
}
