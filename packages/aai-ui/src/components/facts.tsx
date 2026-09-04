// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ReactNode } from "react";

/** What goes between two facts. A separator, not a bullet — U+00B7, not U+2022. */
const FACT_SEPARATOR = " · ";

/**
 * Props for {@link Facts}.
 *
 * @public
 */
export type FactsProps = {
  /**
   * The facts, in reading order. Anything `false`, `null`, `undefined` or the
   * empty string is DROPPED, so a page writes `cond && \`${n} skipped\`` inline
   * instead of splicing a separator into a conditional string.
   *
   * `0` is NOT dropped — it is a fact ("0 words"), and treating it as absent is
   * the bug a plain truthiness filter would ship.
   *
   * They are TEXT rather than `ReactNode`: every one of the nine lines this
   * replaced was a string, and taking strings is what lets this JOIN them (see
   * the component doc) instead of interleaving keyed separator elements.
   */
  items: readonly (string | number | false | null | undefined)[];
  /**
   * Which of the two muted typographies the pages use. `"sm"` is
   * `text-sm opacity-70`, `"xs"` is `text-xs opacity-60` — the size and the
   * muting move together, because that is the pair every site had.
   */
  size?: "sm" | "xs" | undefined;
  /**
   * The element to render. `"p"` by default; `"span"` for a line that sits
   * inside phrasing content, where a `<p>` is invalid nesting the browser will
   * reparent out from under React.
   */
  as?: "p" | "span" | undefined;
  /**
   * ADDED to the base classes rather than replacing them — `tabular-nums`,
   * `uppercase tracking-[1.2px]`. There is no `tailwind-merge` in this package,
   * so a class that CONFLICTS with a base one is not reliably the winner.
   */
  className?: string | undefined;
};

/**
 * A muted line of run facts, joined by `·` — "6 segments · 12:04 of audio ·
 * 1,840 words".
 *
 * Nine pages had written this by hand under four different typographies for
 * one role, two of them (`call-audit` and `spoken-summary`) byte-identical down
 * to the payload. Three things it takes off the caller:
 *
 * - **The separator cannot be forgotten, and neither can the space around it.**
 *   Four of the nine carried a literal `{" "}` at the end of a line, because
 *   Prettier's wrap ate the space that made `· ` read as a separator rather
 *   than as punctuation glued to the next word. A line that is correct only
 *   because somebody remembered an invisible JSX expression is exactly the
 *   thing a component should own.
 * - **A fact worth omitting is omitted, and by the caller's own condition.**
 *   The hand-written shape for a conditional fact was to splice the separator
 *   into the string — `{x ? \` · budget exhausted\` : ""}` — which puts the
 *   punctuation in two places and gets the leading separator wrong the moment
 *   the fact before it also disappears. Passing the condition and letting this
 *   drop it keeps the separator in one place.
 * - **A line with nothing left to say renders NOTHING.** With every fact
 *   conditional, the alternative is a muted empty row, or a bare `·`.
 *
 * The facts are JOINED into one string rather than interleaved as elements, and
 * that is why the prop is text: joined, there is no per-fact `key` to invent —
 * the same reasoning `WorkflowProgress` gives for its log lines. A line that
 * genuinely needs an element in it (a link) wants its own markup.
 *
 * @example
 * ```tsx
 * import { Facts } from "@alexkroman1/aai-ui";
 *
 * function RunFacts({ words, cut }: { words: number; cut: number }) {
 *   return <Facts size="xs" items={[`${words} words`, cut > 0 && `${cut} blind cuts`]} />;
 * }
 * ```
 *
 * @param props - Facts-line props.
 *
 * @public
 */
export function Facts({ items, size = "sm", as = "p", className }: FactsProps): ReactNode {
  const shown = items.filter(
    (item) => item !== false && item !== null && item !== undefined && item !== "",
  );
  if (shown.length === 0) return null;

  const text = shown.join(FACT_SEPARATOR);
  const classes = clsx(size === "xs" ? "text-xs opacity-60" : "text-sm opacity-70", className);
  return as === "span" ? (
    <span className={classes}>{text}</span>
  ) : (
    <p className={classes}>{text}</p>
  );
}
