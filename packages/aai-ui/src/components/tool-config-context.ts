// Copyright 2025 the AAI authors. MIT license.

import { type Context, createContext, useContext } from "react";

/**
 * Display configuration for a tool call in the UI, keyed by tool name.
 *
 * `mountClient({ tools })` is the OVERRIDE half of it: the base is what each
 * tool declared with `tool({ ui })`, which the agent serves in its
 * `GET /client-config` body and `mountClient()` merges underneath this, per
 * key. An entry's `undefined` field is "no override", not "no icon".
 *
 * @public
 */
export type ToolDisplayConfig = Record<
  string,
  { icon?: string | undefined; label?: string | undefined }
>;

/**
 * Context for tool display configuration. Installed by `mountClient()` from
 * `ClientConfig.tools`; the built-in components read it via `useToolConfig`.
 *
 * @internal
 */
export const ToolConfigContext: Context<ToolDisplayConfig> = createContext<ToolDisplayConfig>({});

/**
 * Read tool display configuration from the nearest `ToolConfigContext.Provider`.
 *
 * @internal
 */
export function useToolConfig(): ToolDisplayConfig {
  return useContext(ToolConfigContext);
}
