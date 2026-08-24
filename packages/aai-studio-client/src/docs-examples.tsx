// Copyright 2026 the AAI authors. MIT license.
// One worked example on the API pane: the SDK call, with the other ways to make
// it a click away.
//
// Its own module because two cards render it now — the workflow sections in
// `api-docs.tsx` and the upload section in `docs-uploads.tsx` — and a second
// copy is how one of them ends up without the disclosure, or with the languages
// in the other order. Same argument as `snippet.tsx`, which this is built out
// of.

import { Snippet } from "./snippet.tsx";

/**
 * A follow-on example inside a card: a rule off the top border, the sentence
 * that says what the call below is for, and the call.
 *
 * Four sections across the two cards are exactly this shape, and the divider
 * is what makes them read as separate answers rather than one listing — so it
 * is a component, for the same reason {@link Examples} is one: a fifth copy is
 * how one of them loses the rule, or the note's size.
 */
export function FollowUp({ note, children }: { note: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4">
      <span className="text-[11px] text-muted">{note}</span>
      {children}
    </div>
  );
}

/**
 * The DEFAULT is the SDK for every section on the pane — see `docs-snippets.ts`
 * for why — and `curl` and the CLI are `<details>` rather than a language
 * switcher because they are answers to a different question ("I am not in
 * TypeScript") rather than a preference to remember. A `<details>` also keeps
 * both in the DOM, so a reader searching the page for `curl` still finds it.
 */
export function Examples({
  code,
  label,
  alternates = [],
}: {
  code: string;
  label: string;
  alternates?: readonly { language: string; code: string }[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <Snippet code={code} label={label} />
      {alternates.map((alt) => (
        <details key={alt.language}>
          <summary className="cursor-pointer text-[11px] text-muted">
            Same call with {alt.language}
          </summary>
          <div className="pt-2">
            <Snippet code={alt.code} label={`${label} with ${alt.language}`} />
          </div>
        </details>
      ))}
    </div>
  );
}
