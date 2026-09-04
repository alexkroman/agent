// Copyright 2026 the AAI authors. MIT license.
// A block of code with its own copy button.
//
// Its own module because the API docs are now rendered in TWO places — the
// studio's API pane and the public page at `/studio/api/<slug>` — and this is
// the atom both are largely made of. Shared rather than copied for the reason
// `settings-card.tsx` is: a second copy is how one of them ends up with a
// different font size and no copy button.

import { type UseCopyResult, useCopy } from "@alexkroman1/aai-ui";

export function Snippet({ code, label }: { code: string; label: string }) {
  const copier = useCopy();
  return (
    <div className="flex items-start gap-2">
      {/* `<pre>`, not styled spans: this exists to be selected and pasted, and
          any markup inside the block is markup a copy picks up. */}
      <pre className="m-0 min-w-0 flex-1 overflow-x-auto rounded-md border border-line bg-cream p-3 font-mono text-[11px] leading-relaxed whitespace-pre">
        {code}
      </pre>
      <button
        type="button"
        className="btn px-2 py-1 text-xs"
        onClick={() => copier.copy(code)}
        aria-label={`Copy: ${label}`}
      >
        {copier.label(code)}
      </button>
    </div>
  );
}

/**
 * One LINE of text with its own copy button — a webhook URL, a CLI command.
 *
 * The narrow sibling of {@link Snippet}: same button, but a `<code>` that wraps
 * on `break-all` instead of a `<pre>` that scrolls, because these are single
 * strings the reader wants to see whole. It was written out twice, in
 * cli-commands.tsx and phone-card.tsx, byte-identical apart from the aria-label.
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
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 rounded-md border border-line bg-cream px-3 py-2 font-mono text-xs break-all">
        {text}
      </code>
      <button
        type="button"
        className="btn px-2 py-1 text-xs"
        onClick={() => copier.copy(text)}
        aria-label={label}
      >
        {copier.label(text)}
      </button>
    </div>
  );
}
