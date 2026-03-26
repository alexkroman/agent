// Copyright 2025 the AAI authors. MIT license.

import clsx from "clsx";
import type * as preact from "preact";
import type { AgentState, Reactive } from "../types.ts";

/**
 * Colored dot + label showing the current {@link AgentState}.
 *
 * State-to-color mapping:
 * - `disconnected` — gray
 * - `connecting` — yellow
 * - `ready` — green
 * - `listening` — blue
 * - `thinking` — purple
 * - `speaking` — red
 * - `error` — red
 *
 * @example
 * ```tsx
 * const { session } = useSession();
 * <StateIndicator state={session.state} />
 * ```
 *
 * @param state - A reactive {@link AgentState} value.
 * @param className - Additional CSS class names.
 *
 * @public
 */
export function StateIndicator({
  state,
  className,
}: {
  state: Reactive<AgentState>;
  className?: string;
}): preact.JSX.Element {
  return (
    <div
      class={clsx(
        "inline-flex items-center justify-center gap-1.5 text-[13px] font-medium leading-[130%] text-aai-text-muted capitalize",
        className,
      )}
    >
      <div
        data-state={state.value}
        class="w-2 h-2 rounded-full data-[state=disconnected]:bg-aai-state-disconnected data-[state=connecting]:bg-aai-state-connecting data-[state=ready]:bg-aai-state-ready data-[state=listening]:bg-aai-state-listening data-[state=thinking]:bg-aai-state-thinking data-[state=speaking]:bg-aai-state-speaking data-[state=error]:bg-aai-state-error"
      />
      {state.value}
    </div>
  );
}
