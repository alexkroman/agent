// Copyright 2025 the AAI authors. MIT license.

import type { ComponentChildren, JSX } from "preact";
import { createContext, h } from "preact";
import { useContext } from "preact/hooks";
import type { VoiceSession } from "./session.ts";

// ─── Session context ─────────────────────────────────────────────────────────

const SessionCtx = createContext<VoiceSession | null>(null);

/**
 * Preact context provider that makes the voice session available to descendant
 * components via {@link useSession}.
 *
 * @param props - Provider props. `value` is the voice session to provide. `children` are child components that may consume the context.
 * @returns A Preact VNode wrapping children in the session context.
 *
 * @public
 */
export function SessionProvider({
  value,
  children,
}: {
  value: VoiceSession;
  children?: ComponentChildren;
}): JSX.Element {
  return h(SessionCtx.Provider, { value }, children);
}

/**
 * Hook to access the voice session from within a {@link SessionProvider}.
 *
 * @returns The {@link VoiceSession} from the nearest provider.
 * @throws If called outside of a `SessionProvider`.
 *
 * @public
 */
export function useSession(): VoiceSession {
  const ctx = useContext(SessionCtx);
  if (!ctx) throw new Error("Hook useSession() requires a SessionProvider");
  return ctx;
}

// ─── Client config context ───────────────────────────────────────────────────

/**
 * Theme overrides for the default UI. Applied as CSS custom properties.
 *
 * @public
 */
export type ClientTheme = {
  /** Background color. Default: `#101010`. */
  bg?: string;
  /** Primary accent color. Default: `#fab283`. */
  primary?: string;
  /** Main text color. */
  text?: string;
  /** Surface/card color. */
  surface?: string;
  /** Border color. */
  border?: string;
};

/**
 * Resolved client-level configuration available to default UI components.
 *
 * @public
 */
export type ClientConfig = {
  title?: string | undefined;
  theme?: ClientTheme | undefined;
};

const ConfigCtx = createContext<ClientConfig>({});

export const ClientConfigProvider = ConfigCtx.Provider;

/**
 * Read client config (title, theme) from the nearest provider.
 *
 * @public
 */
export function useClientConfig(): ClientConfig {
  return useContext(ConfigCtx);
}
