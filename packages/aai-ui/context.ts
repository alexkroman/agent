// Copyright 2025 the AAI authors. MIT license.

import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
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

export function useSession(): Session {
  const core = useContext(SessionCtx);
  if (!core) throw new Error("useSession must be used within <SessionProvider>");
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

const ThemeCtx = createContext<Required<ClientTheme>>(DEFAULT_THEME);

export function ThemeProvider({ value, children }: { value?: ClientTheme; children?: ReactNode }) {
  const merged = value ? { ...DEFAULT_THEME, ...value } : DEFAULT_THEME;
  return createElement(ThemeCtx.Provider, { value: merged }, children);
}

export function useTheme(): Required<ClientTheme> {
  return useContext(ThemeCtx);
}

export { DEFAULT_THEME };
