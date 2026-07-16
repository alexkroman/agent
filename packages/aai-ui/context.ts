// Copyright 2025 the AAI authors. MIT license.

import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useSyncExternalStore,
} from "react";
import type { SessionCore, SessionSnapshot } from "./session-core.ts";
import type { ClientTheme } from "./types.ts";

const DEFAULT_THEME: Required<ClientTheme> = {
  bg: "#101010",
  primary: "#fab283",
  text: "rgba(255, 255, 255, 0.94)",
  surface: "#151515",
  border: "#282828",
};

const SessionCtx = createContext<SessionCore | null>(null);

export function SessionProvider({ value, children }: { value: SessionCore; children?: ReactNode }) {
  return createElement(SessionCtx.Provider, { value }, children);
}

export type Session = SessionSnapshot & {
  start(): void;
  cancel(): void;
  resetState(): void;
  reset(): void;
  disconnect(): void;
  toggle(): void;
};

/**
 * Return the raw {@link SessionCore} from context without subscribing to
 * snapshot changes. Useful for accessing stable methods (`start`, `toggle`,
 * `reset`, …) from components that select narrow state via
 * {@link useSessionSelector}.
 *
 * Not part of the package's public export surface — internal to aai-ui
 * components.
 */
export function useSessionCore(): SessionCore {
  const core = useContext(SessionCtx);
  if (!core) throw new Error("Session hooks must be used within <SessionProvider>");
  return core;
}

export function useSession(): Session {
  const core = useSessionCore();
  const snapshot = useSyncExternalStore(core.subscribe, core.getSnapshot);
  return {
    ...snapshot,
    start: core.start,
    cancel: core.cancel,
    resetState: core.resetState,
    reset: core.reset,
    disconnect: core.disconnect,
    toggle: core.toggle,
  };
}

/**
 * Subscribe to a narrow slice of the session snapshot.
 *
 * Unlike {@link useSession} — which re-renders the component on *every*
 * snapshot change — this only triggers a re-render when the selected value
 * changes (per `isEqual`, default `Object.is`). Use it for components that
 * read a single field, e.g. `useSessionSelector((s) => s.running)`.
 *
 * The selector must be pure. It may run on every snapshot change, so keep it
 * cheap; when it returns a derived object, pass a custom `isEqual` to avoid
 * re-renders on referentially-new-but-equal results.
 *
 * @public
 */
export function useSessionSelector<T>(
  selector: (snapshot: SessionSnapshot) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const core = useSessionCore();
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;
  // Cache the last selection so getSelection returns a referentially stable
  // value when the selected slice is unchanged — useSyncExternalStore uses
  // Object.is on the returned value to decide whether to re-render.
  const cacheRef = useRef<{ hasValue: false } | { hasValue: true; value: T }>({ hasValue: false });
  const getSelection = useCallback((): T => {
    const next = selectorRef.current(core.getSnapshot());
    const cache = cacheRef.current;
    if (cache.hasValue && isEqualRef.current(cache.value, next)) return cache.value;
    cacheRef.current = { hasValue: true, value: next };
    return next;
  }, [core]);
  return useSyncExternalStore(core.subscribe, getSelection);
}

const ThemeCtx = createContext<Required<ClientTheme>>(DEFAULT_THEME);

export function ThemeProvider({
  value,
  children,
}: {
  value?: ClientTheme | undefined;
  children?: ReactNode;
}) {
  const merged = value ? { ...DEFAULT_THEME, ...value } : DEFAULT_THEME;
  return createElement(ThemeCtx.Provider, { value: merged }, children);
}

export function useTheme(): Required<ClientTheme> {
  return useContext(ThemeCtx);
}
