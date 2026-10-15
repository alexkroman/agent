// Copyright 2026 the AAI authors. MIT license.
// One line of text with its own copy button.

import type { UseCopyResult } from "@alexkroman1/aai-ui";

/**
 * One LINE of text with its own copy button — a webhook URL, a CLI command.
 *
 * A `<code>` that wraps on `break-all`, because these are single strings the
 * reader wants to see whole.
 *
 * Takes the card's {@link UseCopyResult} rather than calling `useCopy` itself: the
 * flash is one-at-a-time per hook instance, so a per-row instance would change
 * what happens when a reader copies two rows in a row.
 */
export function CopyLine({
  text,
  label,
  copier,
}: {
  text: string;
  /** What the copy button announces — the row's own name for the string. */
  label: string;
  copier: UseCopyResult;
}) {
  return (
    // `items-start` + a 36px floor on the code box: the button is the same
    // height as a one-line box, and stays on the first line when one wraps.
    <div className="flex items-start gap-2">
      <code className="flex min-h-9 min-w-0 flex-1 items-center rounded-md border border-line bg-cream px-3 py-1.5 font-mono text-xs break-all">
        {text}
      </code>
      <button type="button" className="btn" onClick={() => copier.copy(text)} aria-label={label}>
        {copier.label(text)}
      </button>
    </div>
  );
}
