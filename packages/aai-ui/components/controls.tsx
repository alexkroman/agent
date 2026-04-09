// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import { useSession, useTheme } from "../context.ts";
import { Button } from "./button.tsx";

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
export function Controls({ className }: { className?: string }) {
  const { running, toggle, reset } = useSession();
  const theme = useTheme();

  return (
    <div
      className={clsx("flex gap-2 px-4 py-3 border-t shrink-0", className)}
      style={{ borderColor: theme.border }}
    >
      <Button variant="secondary" onClick={toggle}>
        {running ? "Stop" : "Resume"}
      </Button>
      <Button variant="ghost" onClick={reset}>
        New Conversation
      </Button>
    </div>
  );
}
