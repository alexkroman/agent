// Copyright 2025 the AAI authors. MIT license.
import { createContext } from "preact";
import { useContext } from "preact/hooks";

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

const Ctx = createContext<ClientConfig>({});

export const ClientConfigProvider = Ctx.Provider;

/**
 * Read client config (title, theme) from the nearest provider.
 *
 * @public
 */
export function useClientConfig(): ClientConfig {
  return useContext(Ctx);
}
