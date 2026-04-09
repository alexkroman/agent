// Copyright 2025 the AAI authors. MIT license.

// biome-ignore lint/correctness/noUndeclaredDependencies: preact migration in progress (Task 4)
import type { ComponentChildren, JSX } from "preact";
// biome-ignore lint/correctness/noUndeclaredDependencies: preact migration in progress (Task 4)
import { createContext, h } from "preact";
// biome-ignore lint/correctness/noUndeclaredDependencies: preact migration in progress (Task 4)
import { useContext } from "preact/hooks";
import type { VoiceSession } from "./session.ts";
import type { ClientTheme } from "./types.ts";

export type { ClientTheme } from "./types.ts";

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
