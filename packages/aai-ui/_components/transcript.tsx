// Copyright 2025 the AAI authors. MIT license.

import clsx from "clsx";
import type * as preact from "preact";
import type { Reactive } from "../types.ts";
import { ThinkingIndicator } from "./thinking-indicator.tsx";

/** @public */
export function Transcript({
  userUtterance,
  className,
}: {
  userUtterance: Reactive<string | null>;
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
