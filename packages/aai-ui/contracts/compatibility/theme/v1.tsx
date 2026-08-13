// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:theme` epoch 1.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * The five tokens a client sets and a component reads back. `useTheme` returns
 * them `Required`, because the provider fills every one — which is what lets a
 * custom component style itself without repeating the defaults.
 */

import { type ClientTheme, useTheme } from "../../../index.ts";

/** Every token, and each one optional at the call site. */
export const theme: ClientTheme = {
  bg: "#0b1020",
  primary: "#6366f1",
  text: "#e2e8f0",
  surface: "#111827",
  border: "#1f2937",
};

/** Partial is legal too: the rest keep their defaults. */
export const accentOnly: ClientTheme = { primary: "#22c55e" };

export function Badge({ children }: { children: string }) {
  const resolved: Required<ClientTheme> = useTheme();
  return (
    <span
      style={{
        background: resolved.surface,
        color: resolved.text,
        border: `1px solid ${resolved.border}`,
        outlineColor: resolved.primary,
      }}
    >
      {children}
    </span>
  );
}
