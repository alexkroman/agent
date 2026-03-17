// Copyright 2025 the AAI authors. MIT license.

import type { Signal } from "@preact/signals";
import type * as preact from "preact";
import { ThinkingIndicator } from "./thinking_indicator.tsx";

export function Transcript({
  userUtterance,
}: {
  userUtterance: Signal<string | null>;
}): preact.JSX.Element | null {
  if (userUtterance.value === null) return null;
  return (
    <div class="flex flex-col items-end w-full">
      <div class="max-w-[min(82%,64ch)] whitespace-pre-wrap wrap-break-word text-sm leading-[150%] text-aai-text-muted bg-aai-surface-faint border border-aai-border px-3 py-2 rounded-aai ml-auto">
        {userUtterance.value || <ThinkingIndicator />}
      </div>
    </div>
  );
}
