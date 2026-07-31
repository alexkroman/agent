// Copyright 2025 the AAI authors. MIT license.

import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
// The non-shim entry point delegates to React's native useSyncExternalStore
// (guaranteed by the React 18+ peer) instead of bundling the userland shim.
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/with-selector";
import type { SessionCore, SessionSnapshot } from "./session-core.ts";
import type { ClientTheme } from "./types.ts";

// AssemblyAI design system ("website refresh"): warm cream surface, deep
// indigo primary, warm-ink text, taupe borders. Overridable per client via
// `client({ theme })`.
const DEFAULT_THEME: Required<ClientTheme> = {
  bg: "#FBF8F2",
  primary: "#3F2BC1",
  text: "#1B1A18",
  surface: "#FFFFFF",
  border: "#DCD7CC",
};

const SessionCtx = createContext<SessionCore | null>(null);

export function SessionProvider({ value, children }: { value: SessionCore; children?: ReactNode }) {
  return createElement(SessionCtx.Provider, { value }, children);
}

/** The session snapshot merged with the core's control methods. Method
 *  signatures come from {@link SessionCore} — one source of truth. */
export type Session = SessionSnapshot &
  Pick<SessionCore, "start" | "cancel" | "resetState" | "reset" | "disconnect" | "toggle">;

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
  // Methods are stable per core; memoizing the merged object keeps the
  // returned Session referentially stable across renders the snapshot didn't
  // cause (parent re-renders), so consumers can use it in hook deps.
  return useMemo(
    () => ({
      ...snapshot,
      start: core.start,
      cancel: core.cancel,
      resetState: core.resetState,
      reset: core.reset,
      disconnect: core.disconnect,
      toggle: core.toggle,
    }),
    [snapshot, core],
  );
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
  // React's own shim handles the selection cache: the selected value stays
  // referentially stable while `isEqual` says it's unchanged, so only a
  // changed slice triggers a re-render.
  return useSyncExternalStoreWithSelector(
    core.subscribe,
    core.getSnapshot,
    core.getSnapshot,
    selector,
    isEqual,
  );
}

const ThemeCtx = createContext<Required<ClientTheme>>(DEFAULT_THEME);

export function ThemeProvider({
  value,
  children,
}: {
  value?: ClientTheme | undefined;
  children?: ReactNode;
}) {
  // Identity-stable merge: the useChatItems row cache compares theme by
  // reference, so a fresh object per render would rebuild every message row.
  const merged = useMemo(() => (value ? { ...DEFAULT_THEME, ...value } : DEFAULT_THEME), [value]);
  usePageBackground(merged.bg);
  return createElement(ThemeCtx.Provider, { value: merged }, children);
}

/**
 * Paint `html`/`body` with the theme background.
 *
 * Components paint `theme.bg` on their own containers, but the page behind
 * them keeps whatever the static `<style>` in index.html set. Any viewport
 * wider (or taller) than the app column then shows that color as a border
 * around the UI — which is how a cream theme ended up letterboxed in black.
 * Driving it from the theme means a custom `client({ theme })` covers the
 * page too, instead of trading one hardcoded color for another.
 */
function usePageBackground(bg: string): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const { body, documentElement: html } = document;
    const previous = { body: body.style.background, html: html.style.background };
    body.style.background = bg;
    html.style.background = bg;
    return () => {
      body.style.background = previous.body;
      html.style.background = previous.html;
    };
  }, [bg]);
}

export function useTheme(): Required<ClientTheme> {
  return useContext(ThemeCtx);
}
