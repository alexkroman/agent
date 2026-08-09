// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { pageBaseUrl } from "../_utils.ts";
import { useSessionSelector, useTheme } from "../context.ts";
import { INK_FAINT_PCT, INK_MUTED_PCT, INK_SURFACE_PCT, inkTint } from "./_colors.ts";

/** How long the "Copied" confirmation replaces the label after a click. */
const COPIED_FEEDBACK_MS = 1500;

/**
 * A compact labeled chip showing a URL. Click to copy.
 *
 * The label is what makes a pair of these readable — on its own a bare URL
 * leaves you guessing whether it's the page or the socket.
 *
 * @internal
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
  // The feedback timer must not outlive the chip — a setState after unmount
  // is a leak (and a React warning). Re-clicking also resets the countdown.
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  function copy(): void {
    navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(true);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
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
      className={clsx(
        "flex items-center gap-1.5 min-w-0 appearance-none m-0 px-2 py-1 rounded-aai border cursor-pointer text-[11px] leading-none font-aai-mono",
        // Same story as Button: `outline-none` sat here alone, so a chip
        // reachable by Tab showed nothing at all when it got focus.
        "outline-none focus-visible:[outline:2px_solid] focus-visible:[outline-offset:2px]",
        className,
      )}
      style={{
        background: inkTint(theme.text, theme.surface, INK_SURFACE_PCT),
        borderColor: theme.border,
        color: inkTint(theme.text, theme.surface, INK_FAINT_PCT),
        outlineColor: theme.primary,
      }}
      data-testid={testId}
    >
      <span
        className="uppercase tracking-wide shrink-0"
        style={{ color: inkTint(theme.text, theme.surface, INK_MUTED_PCT) }}
      >
        {copied ? "Copied" : label}
      </span>
      <span className="truncate" data-testid={`${testId}-url`}>
        {url}
      </span>
    </button>
  );
}

/**
 * The session's shareable UI URL — the page this UI is served from, what
 * you'd send someone to talk to the agent.
 *
 * @internal
 */
export function UiUrlChip({ className }: { className?: string | undefined }) {
  return (
    <UrlChip
      label="UI"
      url={pageBaseUrl()}
      hint="Shareable UI"
      testId="ui-url-chip"
      className={className}
    />
  );
}

/**
 * The session's programmatic WebSocket endpoint — the URL a script or backend
 * can connect to directly instead of using this UI.
 *
 * @internal
 */
export function ApiUrlChip({ className }: { className?: string | undefined }) {
  const apiUrl = useSessionSelector((s) => s.apiUrl);
  return (
    <UrlChip
      label="API"
      url={apiUrl}
      hint="API endpoint"
      testId="api-url-chip"
      className={className}
    />
  );
}

/**
 * The UI and API URLs side by side. They answer the same question — "how do I
 * reach this agent?" — so they belong together and each needs its label to be
 * told apart. Rendered by the default shell in every session mode (S2S,
 * pipeline).
 *
 * @internal
 */
export function SessionUrlChips({ className }: { className?: string | undefined }) {
  return (
    <div className={clsx("flex items-center gap-1.5 min-w-0", className)}>
      <UiUrlChip className="min-w-0 flex-1" />
      <ApiUrlChip className="min-w-0 flex-1" />
    </div>
  );
}
