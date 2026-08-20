// Copyright 2026 the AAI authors. MIT license.
// A block of code with its own copy button.
//
// Its own module because the API docs are now rendered in TWO places — the
// studio's API pane and the public page at `/studio/api/<slug>` — and this is
// the atom both are largely made of. Shared rather than copied for the reason
// `settings-card.tsx` is: a second copy is how one of them ends up with a
// different font size and no copy button.

import { useCopy } from "./use-copy.ts";

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
