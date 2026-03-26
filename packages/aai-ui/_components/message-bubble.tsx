// Copyright 2025 the AAI authors. MIT license.

import clsx from "clsx";
import type * as preact from "preact";
import type { ChatMessage } from "../types.ts";

/**
 * Renders a single chat message as a styled bubble.
 *
 * - **User** messages appear right-aligned with a faint surface background.
 * - **Assistant** messages appear left-aligned as plain text.
 *
 * @example
 * ```tsx
 * <MessageBubble message={{ role: "user", content: "Hello!" }} />
 * <MessageBubble message={{ role: "assistant", content: "Hi there!" }} />
 * ```
 *
 * @param message - The chat message to display (see {@link ChatMessage}).
 * @param className - Additional CSS class names applied to the root element.
 *
 * @public
 */
export function MessageBubble({
  message,
  className,
}: {
  message: ChatMessage;
  className?: string;
}): preact.JSX.Element {
  const isUser = message.role === "user";
  if (isUser) {
    return (
      <div class={clsx("flex flex-col w-full items-end", className)}>
        <div class="max-w-[min(82%,64ch)] bg-aai-surface-faint border border-aai-border px-3 py-2 rounded-aai whitespace-pre-wrap wrap-break-word text-sm font-normal leading-[150%] text-aai-text">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div
      class={clsx(
        "whitespace-pre-wrap wrap-break-word text-sm font-normal leading-[150%] text-aai-text",
        className,
      )}
    >
      {message.content}
    </div>
  );
}
