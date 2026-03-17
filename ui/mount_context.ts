// Copyright 2025 the AAI authors. MIT license.
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { MountTheme } from "./mount.tsx";

/** Resolved mount-level configuration available to default UI components. */
export type MountConfig = {
  title?: string | undefined;
  theme?: MountTheme | undefined;
};

const Ctx = createContext<MountConfig>({});

export const MountConfigProvider = Ctx.Provider;

/** Read mount config (title, theme) from the nearest provider. */
export function useMountConfig(): MountConfig {
  return useContext(Ctx);
}
