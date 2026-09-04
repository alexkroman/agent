// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import { pageBaseUrl } from "../_utils.ts";
import { useSessionSelector, useTheme } from "../context.ts";
import { useCopy } from "../use-copy.ts";
import {
  FOCUS_RING,
  focusRingStyle,
  INK_FAINT_PCT,
  INK_MUTED_PCT,
  INK_SURFACE_PCT,
  inkTint,
} from "./_colors.ts";

/**
 * A compact labeled chip showing a URL. Click to copy.
 *
 * The label is what makes a pair of these readable — on its own a bare URL
 * leaves you guessing whether it's the page or the socket. It also carries the
 * copy OUTCOME, which is the whole reason the flash is `useCopy`'s rather than
 * this file's: the hand-rolled version swallowed a rejected write, so on an
 * insecure context or a denied permission the chip changed nothing at all and
 * read as a dead button.
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
  // One copier per chip: each renders a single URL, so there is no sibling
  // whose "Copied" this one has to clear.
  const copier = useCopy();

  return (
    <button
      type="button"
      onClick={() => copier.copy(url)}
      title={`${hint} (click to copy)\n${url}`}
      className={clsx(
        "flex items-center gap-1.5 min-w-0 appearance-none m-0 px-2 py-1 rounded-aai border cursor-pointer text-[11px] leading-none font-aai-mono",
        FOCUS_RING,
        className,
      )}
      style={{
        background: inkTint(theme.text, theme.surface, INK_SURFACE_PCT),
        borderColor: theme.border,
        color: inkTint(theme.text, theme.surface, INK_FAINT_PCT),
        ...focusRingStyle(theme.primary),
      }}
      data-testid={testId}
    >
      <span
        className="uppercase tracking-wide shrink-0"
        style={{ color: inkTint(theme.text, theme.surface, INK_MUTED_PCT) }}
      >
        {copier.label(url, label)}
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
