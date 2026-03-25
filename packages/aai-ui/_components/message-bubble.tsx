// Copyright 2025 the AAI authors. MIT license.

import clsx from "clsx";
import type * as preact from "preact";
import type { Message } from "../types.ts";

/** @public */
export function MessageBubble({
  message,
  className,
}: {
  message: Message;
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
