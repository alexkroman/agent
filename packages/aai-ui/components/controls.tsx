// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import { memo } from "react";
import { useSessionCore, useSessionSelector } from "../context.ts";
import { Button } from "./button.tsx";
import { SessionUrlChips } from "./url-chips.tsx";

/**
 * Session control buttons: **Stop / Resume** and **New Conversation**.
 *
 * Reads session state from {@link useSession}. Must be rendered inside a
 * {@link SessionProvider}.
 *
 * @example
 * ```tsx
 * <Controls className="justify-end" />
 * ```
 *
 * @param className - Additional CSS class names applied to the container.
 *
 * @public
 */
// memo(): the only prop is a string, so ChatView re-rendering (state flips,
// errors) never cascades here; the narrow `running` subscription below stays
// the sole re-render trigger.
export const Controls = memo(function Controls({ className }: { className?: string }) {
  // Narrow subscription: only re-render when `running` flips, not on every
  // snapshot change (messages, transcripts, audio state, ...).
  const running = useSessionSelector((s) => s.running);
  const { toggle, reset } = useSessionCore();

  return (
    <div className={clsx("flex items-center gap-3 shrink-0", className)}>
      <Button variant="secondary" onClick={toggle}>
        {running ? "Stop" : "Resume"}
      </Button>
      <Button variant="ghost" onClick={reset}>
        New Conversation
      </Button>
      <SessionUrlChips className="ml-auto max-w-[60%]" />
    </div>
  );
});
