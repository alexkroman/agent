// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import { useState } from "react";
import { useSessionSelector, useTheme } from "../context.ts";
import { SURFACE_TINT, TEXT_FAINT, TEXT_MUTED } from "./_colors.ts";

/** How long the "Copied" confirmation replaces the label after a click. */
const COPIED_FEEDBACK_MS = 1500;

/**
 * A compact labeled chip showing a URL. Click to copy.
 *
 * The label is what makes a pair of these readable — on its own a bare URL
 * leaves you guessing whether it's the page or the socket.
 */
function UrlChip({
  label,
  url,
  hint,
  testId,
  className,
}: {
  label: string;
  url: string;
  hint: string;
  testId: string;
  className?: string | undefined;
}) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);

  function copy(): void {
    navigator.clipboard
      ?.writeText(url)
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
      title={`${hint} (click to copy)\n${url}`}
      className={`flex items-center gap-1.5 min-w-0 appearance-none m-0 px-2 py-1 rounded-aai border cursor-pointer outline-none text-[11px] leading-none font-aai-mono ${className ?? ""}`}
      style={{ background: SURFACE_TINT, borderColor: theme.border, color: TEXT_FAINT }}
      data-testid={testId}
    >
      <span className="uppercase tracking-wide shrink-0" style={{ color: TEXT_MUTED }}>
        {copied ? "Copied" : label}
      </span>
      <span className="truncate" data-testid={`${testId}-url`}>
        {url}
      </span>
    </button>
  );
}

/** The page this UI is served from — what you'd send someone to talk to the agent. */
function pageUrl(): string {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}${window.location.pathname}`;
}

/**
 * The session's shareable UI URL.
 *
 * @public
 */
export function UiUrlChip({ className }: { className?: string | undefined }) {
  return (
    <UrlChip
      label="UI"
      url={pageUrl()}
      hint="Shareable UI"
      testId="ui-url-chip"
      {...(className !== undefined && { className })}
    />
  );
}

/**
 * The session's programmatic WebSocket endpoint — the URL a script or backend
 * can connect to directly instead of using this UI.
 *
 * @public
 */
export function ApiUrlChip({ className }: { className?: string | undefined }) {
  const apiUrl = useSessionSelector((s) => s.apiUrl);
  return (
    <UrlChip
      label="API"
      url={apiUrl}
      hint="API endpoint"
      testId="api-url-chip"
      {...(className !== undefined && { className })}
    />
  );
}

/**
 * The UI and API URLs side by side. They answer the same question — "how do I
 * reach this agent?" — so they belong together and each needs its label to be
 * told apart. Rendered by the default shell in every session mode (S2S,
 * pipeline, text-only).
 *
 * @public
 */
export function SessionUrlChips({ className }: { className?: string | undefined }) {
  return (
    <div className={`flex items-center gap-1.5 min-w-0 ${className ?? ""}`}>
      <UiUrlChip className="min-w-0 flex-1" />
      <ApiUrlChip className="min-w-0 flex-1" />
    </div>
  );
}
