// Copyright 2025 the AAI authors. MIT license.

import { createContext, useContext } from "react";

/**
 * Display configuration for a tool call in the UI.
 *
 * @public
 */
export type ToolDisplayConfig = Record<string, { icon?: string; label?: string }>;

/**
 * Context for tool display configuration.
 * Provided by `client` or manually via `ToolConfigContext.Provider`.
 *
 * @public
 */
export const ToolConfigContext = createContext<ToolDisplayConfig>({});

/**
 * Read tool display configuration from the nearest `ToolConfigContext.Provider`.
 *
 * @internal
 */
export function useToolConfig(): ToolDisplayConfig {
  return useContext(ToolConfigContext);
}
