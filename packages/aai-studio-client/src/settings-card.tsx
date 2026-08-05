// Copyright 2026 the AAI authors. MIT license.
// One Settings-page section: eyebrow heading, blurb, body. The pane is a
// stack of these, and the Database card (its own file for length) renders one
// too — hence a shared module rather than a local in settings.tsx.

import type { ReactNode } from "react";

export function Card({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line bg-panel p-6">
      <div className="flex flex-col gap-2">
        <span className="eyebrow">{title}</span>
        <p className="m-0 max-w-2xl text-[13px] leading-5 text-muted">{blurb}</p>
      </div>
      {children}
    </section>
  );
}
