// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import type { ReactNode } from "react";
import { useTheme } from "../context.ts";

/**
 * The AAI ANSI art logo, rendered as a styled `<pre>` block.
 *
 * @param size - Font size in px. Defaults to 10.
 * @internal
 */
export function AaiLogo({ size = 10 }: { size?: number }): ReactNode {
  const theme = useTheme();
  return (
    <pre
      className="font-aai-mono leading-[1.1] font-bold m-0"
      style={{ color: theme.primary, fontSize: `${size}px` }}
    >
      {/* biome-ignore lint/style/useConsistentCurlyBraces: string contains escape sequence */}
      {"▄▀█ ▄▀█ █\n█▀█ █▀█ █"}
    </pre>
  );
}
