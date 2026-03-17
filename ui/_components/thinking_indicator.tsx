// Copyright 2025 the AAI authors. MIT license.
import type * as preact from "preact";

export function ThinkingIndicator(): preact.JSX.Element {
  return (
    <div class="flex items-center gap-2 text-aai-text-dim text-sm font-medium min-h-5">
      {[0, 0.16, 0.32].map((delay) => (
        <div
          key={delay}
          class="w-1.5 h-1.5 rounded-full bg-aai-text-dim"
          style={{
            animation: "aai-bounce 1.4s infinite ease-in-out both",
            animationDelay: `${delay}s`,
          }}
        />
      ))}
    </div>
  );
}
