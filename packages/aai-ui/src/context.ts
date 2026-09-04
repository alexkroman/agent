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
import type { AgentState, ClientTheme, SessionError } from "./types.ts";

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
 * The session's control methods, and nothing else — what a `client.tsx` may
 * legitimately CALL on a session, as against what it may read.
 *
 * Declared once and merged into {@link Session} rather than written out at both
 * places: the two lists have to be the same list, and a member added to one and
 * not the other is a hook that cannot do what `useSession()` can.
 *
 * Method signatures come from {@link SessionCore} — one source of truth.
 *
 * @public
 */
export type SessionActions = Pick<
  SessionCore,
  "start" | "cancel" | "resetState" | "reset" | "restart" | "disconnect" | "toggle" | "end"
>;

/**
 * What {@link useSession} returns: the live {@link SessionSnapshot} fields
 * (`state`, `messages`, `toolCalls`, `agentState`, live transcripts, `error`,
 * `apiUrl`, `started`/`running`/`recording`, …) merged with the session's
 * control methods (`start`, `toggle`, `reset`, `restart`, `resetState`,
 * `disconnect`, `cancel`, `end`).
 *
 * Note there is no text-send method — sessions are voice-only; the only
 * client→server inputs are audio and the control methods above.
 *
 * @public
 */
export type Session = SessionSnapshot & SessionActions;

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
 * The session's control methods — `start`, `cancel`, `resetState`, `reset`,
 * `restart`, `disconnect`, `toggle`, `end` — with **no snapshot
 * subscription**.
 *
 * This is the narrow half of {@link useSession}, and it is the half a custom
 * chrome could not reach. `<Controls>` and `<StartScreen>` in this package pair
 * a one-field `useSessionSelector` with this package's own `useSessionCore`
 * (`context.ts`, unpublished); a `client.tsx`
 * could not, because that hook is not published — so a footer needing `start`
 * and `toggle` held a WHOLE-SNAPSHOT `useSession()`, and `session-core.ts`
 * rebuilds the snapshot object on every change. Measured consequence: four
 * components across three templates re-rendered on every STT partial and every
 * streaming delta, in files whose every other component is narrowly subscribed
 * on purpose. One of them (`infocom-adventure`'s `TitleScreen`) reads nothing
 * from the snapshot at all and subscribes to all of it for `session.start`.
 *
 * **Why publishing this does not reopen what `/internal` closed.**
 * `useSessionCore` hands back the STORE — `subscribe`, `getSnapshot`,
 * `connect`, `Symbol.dispose` — which is the framework's own plumbing, the same
 * category as the providers and `buildAgentUrl` that live on
 * `@alexkroman1/aai-ui/internal`. A client that holds it can subscribe out of
 * band of React, dial a socket the mount did not, and dispose the session under
 * the tree that is rendering it. What comes back from here is the SAME eight
 * methods `useSession()` already publishes on its result, built into a fresh
 * object rather than passed through, so the store is not reachable from it.
 * There is no new capability here — only the existing one without the
 * subscription tax.
 *
 * Identity-stable per core, so it is safe in a dependency array and in a
 * `memo()` child's props: the methods are closures created once by
 * `createSessionCore`, and the object wrapping them is memoized on the core.
 *
 * Throws outside the provider `client()` installs, like every session hook.
 *
 * @example A footer that acts on the session without re-rendering with it
 * ```tsx
 * import { useSessionActions, useSessionSelector } from "@alexkroman1/aai-ui";
 *
 * function Footer() {
 *   // Two narrow subscriptions and no snapshot read: this row re-renders when
 *   // `running` flips, and not on every transcript delta.
 *   const running = useSessionSelector((s) => s.running);
 *   const { toggle, end } = useSessionActions();
 *   return (
 *     <>
 *       <button onClick={toggle}>{running ? "Pause" : "Resume"}</button>
 *       <button onClick={end}>Hang up</button>
 *     </>
 *   );
 * }
 * ```
 *
 * @returns The eight control methods — see {@link SessionActions}.
 *
 * @public
 */
export function useSessionActions(): SessionActions {
  const core = useSessionCore();
  // Picked rather than returned whole: the point of this hook over
  // `useSessionCore` is that the store's own surface (`subscribe`,
  // `getSnapshot`, `connect`, dispose) is NOT in the returned object, so a
  // client cannot reach it by widening the type back.
  return useMemo(
    () => ({
      start: core.start,
      cancel: core.cancel,
      resetState: core.resetState,
      reset: core.reset,
      restart: core.restart,
      disconnect: core.disconnect,
      toggle: core.toggle,
      end: core.end,
    }),
    [core],
  );
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
  // The actions come from `useSessionActions` rather than being copied off the
  // core a second time: this hook and that one must hand out the same eight
  // methods, and a hand-written second copy is where that stops being true.
  const actions = useSessionActions();
  // Methods are stable per core; memoizing the merged object keeps the
  // returned Session referentially stable across renders the snapshot didn't
  // cause (parent re-renders), so consumers can use it in hook deps.
  return useMemo(() => ({ ...snapshot, ...actions }), [snapshot, actions]);
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

/**
 * The two selectors below are MODULE-SCOPE functions, and that is load-bearing
 * rather than tidy.
 *
 * `useSyncExternalStoreWithSelector` caches its selection keyed on the selector
 * it was handed: a fresh arrow per render invalidates that memo every render,
 * so the selector re-runs and the `isEqual` short-circuit protects only the
 * re-RENDER, never the work. Hoisting them means the two fields more than one
 * chrome ever reads are selected by one stable function for the life of the
 * program — which is also the thing a caller writing the arrow inline cannot
 * do for themselves, and the reason these two are hooks at all rather than a
 * documented one-liner.
 */
const selectState = (s: SessionSnapshot): AgentState => s.state;
const selectError = (s: SessionSnapshot): SessionError | null => s.error;

/**
 * The agent's live {@link AgentState} — `disconnected`, `connecting`, `ready`,
 * `listening`, `thinking`, `speaking`, `error` — on its own narrow
 * subscription.
 *
 * `useSessionSelector((s) => s.state)` spelled once. It is one of exactly two
 * snapshot fields that more than one custom chrome ever selects (the other is
 * {@link useSessionError}), and it had been written inline at eight sites —
 * including inside this package and, worse, in `ConsoleShell`'s own `@example`,
 * which taught the inline form to everyone who read it.
 *
 * **Named `useSessionStatus`, not `useSessionState`.** `useAgentState` is the
 * SLOT hook — the agent's own synced application state, whatever a
 * `sessionSlot()` projects — and `AgentState` here is the phase of the CALL.
 * Two different concepts one letter apart, so the shorter-sounding name is the
 * one deliberately not taken.
 *
 * Pair it with {@link AGENT_STATE_LABELS} for a rendered word; the raw member
 * is a wire value, not a label.
 *
 * @example
 * ```tsx
 * import { AGENT_STATE_LABELS, useSessionStatus } from "@alexkroman1/aai-ui";
 *
 * function StatusDot() {
 *   const status = useSessionStatus();
 *   return <span data-state={status}>{AGENT_STATE_LABELS[status]}</span>;
 * }
 * ```
 *
 * @returns The current agent state.
 *
 * @public
 */
export function useSessionStatus(): AgentState {
  return useSessionSelector(selectState);
}

/**
 * The session's current {@link SessionError}, or `null` when there is none, on
 * its own narrow subscription.
 *
 * The other half of {@link useSessionStatus} — the second of the two fields a
 * custom chrome reads over and over, and the one whose absence is invisible:
 * per the `fatalError` latch in `session-core.ts` the error is the ONLY
 * remaining signal that a session died, since the state beside it goes back to
 * reading like a live one.
 *
 * A chrome rendering it owes `role="alert"` — which is what
 * {@link SessionErrorBanner} is for, and why reaching for that beats reaching
 * for this.
 *
 * @returns The current error, or `null`.
 *
 * @public
 */
export function useSessionError(): SessionError | null {
  return useSessionSelector(selectError);
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
