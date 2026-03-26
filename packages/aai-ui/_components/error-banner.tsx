// Copyright 2025 the AAI authors. MIT license.

import clsx from "clsx";
import type * as preact from "preact";
import type { Reactive, SessionError } from "../types.ts";

/**
 * Displays a session error as a styled inline banner.
 * Returns `null` when there is no active error.
 *
 * @example
 * ```tsx
 * const { session } = useSession();
 * <ErrorBanner error={session.error} />
 * ```
 *
 * @param error - A reactive {@link SessionError} (or `null`).
 * @param className - Additional CSS class names.
 *
 * @public
 */
export function ErrorBanner({
  error,
  className,
}: {
  error: Reactive<SessionError | null>;
  className?: string;
}): preact.JSX.Element | null {
  if (!error.value) return null;
  return (
    <div
      class={clsx(
        "mx-4 mt-3 px-3 py-2 rounded-aai border border-aai-error/40 bg-aai-error/8 text-[13px] leading-[130%] text-aai-error",
        className,
      )}
    >
      {error.value.message}
    </div>
  );
}
