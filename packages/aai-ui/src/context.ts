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
import type { SessionCore, SessionSnapshot } from "./session-core-types.ts";
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

/**
 * Provides the {@link SessionCore} the session hooks read. `client()`
 * installs it automatically; a custom tree only needs it when bypassing
 * `client()` and mounting React itself.
 *
 * @internal
 */
export function SessionProvider({ value, children }: { value: SessionCore; children?: ReactNode }) {
  return createElement(SessionCtx.Provider, { value }, children);
}

/**
 * What {@link useSession} returns: the live {@link SessionSnapshot} fields
 * (`state`, `messages`, `toolCalls`, `agentState`, live transcripts, `error`,
 * `apiUrl`, `started`/`running`/`recording`, …) merged with the session's
 * control methods (`start`, `toggle`, `reset`, `resetState`, `disconnect`,
 * `cancel`, `end`).
 *
 * Note there is no text-send method — sessions are voice-only; the only
 * client→server inputs are audio and the control methods above.
 *
 * Method signatures come from {@link SessionCore} — one source of truth.
 *
 * @public
 */
export type Session = SessionSnapshot &
  Pick<SessionCore, "start" | "cancel" | "resetState" | "reset" | "disconnect" | "toggle" | "end">;

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

/**
 * Return the live {@link Session}: the current snapshot fields plus the
 * control methods (`start`, `toggle`, `reset`, `resetState`, `disconnect`,
 * `cancel`, `end`).
 *
 * Throws if used outside the provider `client()` installs (the error names
 * `<SessionProvider>` — you only mount that yourself when bypassing
 * `client()`). Re-renders the component on *every* snapshot change; for a
 * component that reads one field, prefer {@link useSessionSelector} for a
 * targeted subscription.
 *
 * @example
 * ```tsx
 * import { useSession } from "@alexkroman1/aai-ui";
 *
 * function Controls() {
 *   const session = useSession();
 *   if (!session.started) return <button onClick={session.start}>Start</button>;
 *   return <button onClick={session.toggle}>{session.running ? "Pause" : "Resume"}</button>;
 * }
 * ```
 *
 * @public
 */
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
      end: core.end,
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
 * @example
 * ```tsx
 * import { useSessionSelector } from "@alexkroman1/aai-ui";
 *
 * // Re-renders when `running` flips, and on nothing else — not on every
 * // transcript delta the way `useSession()` would.
 * function MicDot() {
 *   const running = useSessionSelector((snapshot) => snapshot.running);
 *   return <span>{running ? "●" : "○"}</span>;
 * }
 * ```
 *
 * @param selector - Reads the slice out of the snapshot. Must be pure.
 * @param isEqual - Compares two selected values. Defaults to `Object.is`.
 * @returns The selected slice.
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

/**
 * Provides the theme the components read via `useTheme`. `client()` installs
 * it automatically (from `ClientConfig.theme`); a custom tree only needs it
 * when bypassing `client()` and mounting React itself.
 *
 * @internal
 */
export function ThemeProvider({
  value,
  children,
}: {
  value?: ClientTheme | undefined;
  children?: ReactNode;
}) {
  // Identity-stable merge: `MessageList`'s memoized rows take the theme as a
  // dependency and `MessageBubble` is `memo()`-wrapped on it, so a fresh object
  // per render would rebuild every message row.
  const merged = useMemo(() => (value ? { ...DEFAULT_THEME, ...value } : DEFAULT_THEME), [value]);
  useThemeStyles(merged);
  return createElement(ThemeCtx.Provider, { value: merged }, children);
}

/**
 * The custom property each {@link ClientTheme} field is published as.
 *
 * Named after the field, so `theme.surface` and `--aai-surface` are obviously
 * the same thing, and prefixed for the reason `--aai-btn-bg` and
 * `--aai-sidebar-w` already are: these land on `:root`, where an app's own
 * variables live too.
 *
 * @internal
 */
const THEME_VARS = {
  bg: "--aai-bg",
  surface: "--aai-surface",
  text: "--aai-text",
  border: "--aai-border",
  primary: "--aai-primary",
} as const satisfies Record<keyof Required<ClientTheme>, `--aai-${string}`>;

/**
 * Publish the theme to CSS, and paint the page with it.
 *
 * Two jobs on one element deliberately — both are about the parts of the page
 * React does not own.
 *
 * **The variables.** {@link useTheme} hands a component a JavaScript object, so
 * everything it styles carries an inline `style={{ }}`; measured across the
 * template tree the ratio of `theme.` reads to inline style objects is
 * essentially one to one. A Tailwind class cannot see a JavaScript object — so
 * the five values are written to `:root` as custom properties, `styles.css`
 * maps them into the `@theme` block's `--color-*` namespace, and
 * `className="bg-aai-surface text-aai-text border-aai-border"` works. This is
 * ADDITIVE: `useTheme()` stays, because the derived tints in
 * `components/_colors.ts` `color-mix` on the resolved values and a page is
 * entitled to read them for a `satisfies`-pinned palette.
 *
 * **The background.** Components paint `theme.bg` on their own containers, but
 * the page behind them keeps whatever the static `<style>` in index.html set.
 * Any viewport wider (or taller) than the app column then shows that color as a
 * border around the UI — which is how a cream theme ended up letterboxed in
 * black. It stays an explicit `background` on `html` AND `body` rather than
 * riding on the new variable: a variable only paints where some rule consumes
 * it, and the two elements this is about are the two nothing in this package
 * renders.
 */
function useThemeStyles(theme: Required<ClientTheme>): void {
  const { bg, surface, text, border, primary } = theme;
  useEffect(() => {
    if (typeof document === "undefined") return;
    const { body, documentElement: html } = document;
    const values: Required<ClientTheme> = { bg, surface, text, border, primary };
    const previousVars = Object.entries(THEME_VARS).map(
      ([field, prop]) =>
        [
          prop,
          html.style.getPropertyValue(prop),
          values[field as keyof typeof THEME_VARS],
        ] as const,
    );
    for (const [prop, , next] of previousVars) html.style.setProperty(prop, next);

    const previousBg = { body: body.style.background, html: html.style.background };
    body.style.background = bg;
    html.style.background = bg;

    return () => {
      // Restored rather than removed: a host page may have set its own
      // `--aai-*` before mounting, and a client disposed mid-page must leave
      // that page as it found it.
      for (const [prop, before] of previousVars) {
        if (before === "") html.style.removeProperty(prop);
        else html.style.setProperty(prop, before);
      }
      body.style.background = previousBg.body;
      html.style.background = previousBg.html;
    };
  }, [bg, surface, text, border, primary]);
}

/**
 * Read the resolved theme (every {@link ClientTheme} field filled with its
 * default) from the nearest theme context. Returns the default theme when no
 * provider is present, so components can call it unconditionally.
 *
 * This is how a custom component stays on the agent's palette: a
 * `client({ theme })` override reaches it here, where a hardcoded colour or a
 * Tailwind class cannot see it.
 *
 * @example
 * ```tsx
 * import { useTheme } from "@alexkroman1/aai-ui";
 *
 * function Total({ amount }: { amount: string }) {
 *   const theme = useTheme();
 *   return (
 *     <strong style={{ color: theme.primary, background: theme.surface }}>
 *       {amount}
 *     </strong>
 *   );
 * }
 * ```
 *
 * @returns Every {@link ClientTheme} field, filled in.
 *
 * @public
 */
export function useTheme(): Required<ClientTheme> {
  return useContext(ThemeCtx);
}
