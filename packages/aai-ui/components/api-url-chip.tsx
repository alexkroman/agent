// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import { useState } from "react";
import { useSessionSelector, useTheme } from "../context.ts";
import { SURFACE_TINT, TEXT_FAINT, TEXT_MUTED } from "./_colors.ts";

/** How long the "Copied" confirmation replaces the label after a click. */
const COPIED_FEEDBACK_MS = 1500;

/**
 * A compact chip showing the session's programmatic WebSocket endpoint —
 * the URL a script or backend can connect to directly instead of using this
 * UI. Click to copy. Rendered by the default shell in every session mode
 * (S2S, pipeline, text-only).
 *
 * @public
 */
export function ApiUrlChip({ className }: { className?: string | undefined }) {
  const apiUrl = useSessionSelector((s) => s.apiUrl);
  const theme = useTheme();
  const [copied, setCopied] = useState(false);

  function copy(): void {
    navigator.clipboard
      ?.writeText(apiUrl)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
      })
      .catch(() => {
        /* clipboard unavailable (permissions/insecure context) — chip still shows the URL */
      });
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={`API endpoint (click to copy)\n${apiUrl}`}
      className={`flex items-center gap-1.5 min-w-0 appearance-none m-0 px-2 py-1 rounded-aai border cursor-pointer outline-none text-[11px] leading-none font-aai-mono ${className ?? ""}`}
      style={{ background: SURFACE_TINT, borderColor: theme.border, color: TEXT_FAINT }}
      data-testid="api-url-chip"
    >
      <span className="uppercase tracking-wide shrink-0" style={{ color: TEXT_MUTED }}>
        {copied ? "Copied" : "API"}
      </span>
      <span className="truncate" data-testid="api-url-chip-url">
        {apiUrl}
      </span>
    </button>
  );
}
