// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ReactNode } from "react";

/**
 * Props for {@link BulletList}.
 *
 * @public
 */
export type BulletListProps = {
  /**
   * The bullets, in the order they should read.
   *
   * TEXT rather than `ReactNode`, deliberately: every list this replaced was a
   * string array straight off a run's output, and taking strings is what lets
   * this component key them (see the component doc). A page that needs a link
   * inside a bullet wants its own `<ul>`, not a prop here.
   */
  items: readonly string[];
  /**
   * Rendered as a heading above the list, inside a wrapping `<section>`.
   *
   * Omitted (or `null`/`false`, so `title={cond && "Risks"}` means what it
   * looks like) renders the bare `<ul>` with no wrapper — which is what four of
   * the five lists this replaced were.
   */
  title?: ReactNode | undefined;
  /**
   * `"sm"` adds `text-sm`, which two of the five copies carried and three did
   * not. `"base"` is the default and adds nothing.
   */
  size?: "sm" | "base" | undefined;
  /**
   * ADDED to the list's own classes rather than replacing them. There is no
   * `tailwind-merge` in this package, so a class that CONFLICTS with a base one
   * is not reliably the winner — use this for additions, not overrides.
   */
  className?: string | undefined;
};

/**
 * A disc-bulleted list of short strings — a run's key points, findings, risks.
 *
 * Five pages had written this, byte-identical apart from a `text-sm` suffix on
 * two of them, and all five had the same two defects. Both are the reason this
 * is a component rather than four lines a page repeats:
 *
 * - **All five keyed by the string itself, and these lists are MODEL OUTPUT.**
 *   Two identical bullets are entirely plausible — a summariser that repeats
 *   itself is a bad summary, not a bad program — and a repeated string is then
 *   a duplicate `key`: React warns, and the two `<li>`s contend for one slot in
 *   the reconciliation. What is keyed here instead is the content PLUS how many
 *   times that content has already appeared in this list, which is unique by
 *   construction and unchanged by a re-render that did not change the text.
 *   (Position alone would also be sound — these lists are replaced wholesale by
 *   each new output and never reordered — but it is what `noArrayIndexKey`
 *   exists to talk you out of, and a unique key is one `Map` away, so there is
 *   no reason to spend a lint suppression on it.)
 * - **Three of the five rendered an empty `<ul>` under a heading.** Two had
 *   hand-rolled `if (items.length === 0) return null` and three had not, so the
 *   same absent field was "nothing" on two pages and a stray heading with a
 *   void under it on three. Emptiness renders NOTHING here, `title` included:
 *   a heading over no bullets is a claim the run did not make.
 *
 * @example
 * ```tsx
 * import { BulletList } from "@alexkroman1/aai-ui";
 *
 * function Findings({ risks }: { risks: string[] }) {
 *   return <BulletList title="Risks" items={risks} size="sm" />;
 * }
 * ```
 *
 * @param props - Bullet-list props.
 *
 * @public
 */
export function BulletList({ items, title, size = "base", className }: BulletListProps): ReactNode {
  if (items.length === 0) return null;

  // Rebuilt per render, which is right: the count is a property of THIS list,
  // and the list is a fresh array on every output the page receives.
  const seen = new Map<string, number>();
  const list = (
    <ul
      className={clsx("flex list-disc flex-col gap-1 pl-5", size === "sm" && "text-sm", className)}
    >
      {items.map((item) => {
        const nth = seen.get(item) ?? 0;
        seen.set(item, nth + 1);
        // `<occurrence>:<text>` parses back unambiguously (digits, then the
        // first colon), so two distinct bullets cannot collide on it either.
        return <li key={`${nth}:${item}`}>{item}</li>;
      })}
    </ul>
  );

  const heading = title === undefined || title === null || title === false ? undefined : title;
  if (heading === undefined) return list;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-medium opacity-70">{heading}</h3>
      {list}
    </section>
  );
}
