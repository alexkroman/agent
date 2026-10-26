// Copyright 2025 the AAI authors. MIT license.

import { type Context, createContext, useContext } from "react";

/**
 * Display configuration for a tool call in the UI, keyed by tool name: the
 * icon and label each tool declared with `tool({ ui })`, as the agent serves
 * them in its `GET /client-config` body. `mountClient()` installs the served
 * map as it is — a page has no map of its own to merge over it, so the tool's
 * declaration is the one place a tool's icon lives.
 *
 * Not on the package barrel: nothing an author writes names it (the value a
 * page reads comes from the agent), so it is the context's value type only.
 *
 * @sealed
 * @public
 */
export type ToolDisplayConfig = Record<
  string,
  { icon?: string | undefined; label?: string | undefined }
>;

/**
 * The value the context holds before the lookup lands (and forever, when the
 * lookup fails): one frozen object, so the provider's value is stable across
 * renders rather than a fresh `{}` per commit.
 *
 * @internal
 */
export const EMPTY_TOOL_DISPLAY: ToolDisplayConfig = Object.freeze({});

/**
 * Context for tool display configuration. Installed by `mountClient()` from
 * the agent's `GET /client-config` `tools`; the built-in components read it
 * via `useToolConfig`.
 *
 * @internal
 */
export const ToolConfigContext: Context<ToolDisplayConfig> =
  createContext<ToolDisplayConfig>(EMPTY_TOOL_DISPLAY);

/**
 * Read tool display configuration from the nearest `ToolConfigContext.Provider`.
 *
 * @internal
 */
export function useToolConfig(): ToolDisplayConfig {
  return useContext(ToolConfigContext);
}
