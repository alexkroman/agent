// Copyright 2025 the AAI authors. MIT license.

import type { Signal } from "@preact/signals";
import clsx from "clsx";
import type * as preact from "preact";
import { ThinkingIndicator } from "./thinking-indicator.tsx";

/**
 * Live speech-to-text transcript shown while the user is speaking.
 * Returns `null` when there is no active utterance.
 *
 * Displays a {@link ThinkingIndicator} while waiting for the first
 * transcription text (i.e., `userUtterance` is `""`).
 *
 * @example
 * ```tsx
 * const { session } = useSession();
 * <Transcript userUtterance={session.userUtterance} />
 * ```
 *
 * @param userUtterance - Reactive string (`null` when idle, `""` when
 *   listening but no text yet, or the transcript text).
 * @param className - Additional CSS class names.
 *
 * @public
 */
export function Transcript({
  userUtterance,
  className,
}: {
  userUtterance: Signal<string | null>;
  className?: string;
}): preact.JSX.Element | null {
  if (userUtterance.value === null) return null;
  return (
    <div class={clsx("flex flex-col items-end w-full", className)}>
      <div class="max-w-[min(82%,64ch)] whitespace-pre-wrap wrap-break-word text-sm leading-[150%] text-aai-text-muted bg-aai-surface-faint border border-aai-border px-3 py-2 rounded-aai ml-auto">
        {userUtterance.value || <ThinkingIndicator />}
      </div>
    </div>
  );
}
