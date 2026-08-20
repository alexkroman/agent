// Copyright 2026 the AAI authors. MIT license.
// The page frame the full-width panes share: a scroll region, a centred
// column, and a heading with one line under it.
//
// Extracted when the segmented control went from three panes to six. Settings
// was the only page-shaped pane and had these ~8 lines inline; copying them
// per new pane is how three pages end up with three column widths and two
// scroll behaviours. Two of the classes are load-bearing rather than styling:
// `min-w-0`, without which a flex item's `auto` minimum lets a wide table or a
// long URL stretch the whole shell sideways, and `overflow-y-auto` on this
// element rather than the app — the page scrolls itself, the shell does not.

import type { ReactNode } from "react";

export function PaneShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  /** One line under the heading — what this pane is for, or which project. */
  subtitle: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-cream">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-8 py-8">
        <header className="flex flex-col gap-1">
          <h1 className="m-0 font-serif text-[26px] leading-8 text-fg">{title}</h1>
          <p className="m-0 text-[13px] leading-5 text-muted">{subtitle}</p>
        </header>
        {children}
      </div>
    </div>
  );
}
