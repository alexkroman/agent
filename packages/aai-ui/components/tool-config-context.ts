// Copyright 2025 the AAI authors. MIT license.

import { createContext, useContext } from "react";

export type ToolDisplayConfig = Record<string, { icon?: string; label?: string }>;

export const ToolConfigContext = createContext<ToolDisplayConfig>({});

export function useToolConfig(): ToolDisplayConfig {
  return useContext(ToolConfigContext);
}
