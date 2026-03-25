// Copyright 2025 the AAI authors. MIT license.
import { createContext } from "preact";
import { useContext } from "preact/hooks";

/**
 * Theme overrides for the default UI. Applied as CSS custom properties.
 *
 * @public
 */
export type MountTheme = {
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
 * Resolved mount-level configuration available to default UI components.
 *
 * @public
 */
export type MountConfig = {
  title?: string | undefined;
  theme?: MountTheme | undefined;
};

const Ctx = createContext<MountConfig>({});

export const MountConfigProvider = Ctx.Provider;

/**
 * Read mount config (title, theme) from the nearest provider.
 *
 * @public
 */
export function useMountConfig(): MountConfig {
  return useContext(Ctx);
}
