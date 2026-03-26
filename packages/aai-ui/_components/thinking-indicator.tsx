// Copyright 2025 the AAI authors. MIT license.

import clsx from "clsx";
import type * as preact from "preact";

const DOT_STYLES: preact.JSX.CSSProperties[] = [0, 0.16, 0.32].map((delay) => ({
  animation: "aai-bounce 1.4s infinite ease-in-out both",
  animationDelay: `${delay}s`,
}));

/**
 * Animated three-dot "thinking" indicator shown while the agent is processing.
 *
 * @example
 * ```tsx
 * {isThinking && <ThinkingIndicator />}
 * ```
 *
 * @param className - Additional CSS class names.
 *
 * @public
 */
export function ThinkingIndicator({ className }: { className?: string }): preact.JSX.Element {
  return (
    <div
      class={clsx(
        "flex items-center gap-2 text-aai-text-dim text-sm font-medium min-h-5",
        className,
      )}
    >
      {DOT_STYLES.map((style, i) => (
        <div key={i} class="w-1.5 h-1.5 rounded-full bg-aai-text-dim" style={style} />
      ))}
    </div>
  );
}
