// Copyright 2025 the AAI authors. MIT license.

import type { Signal } from "@preact/signals";
import type * as preact from "preact";
import { cn } from "../_cn.ts";
import type { AgentState } from "../types.ts";

export function StateIndicator({
  state,
  className,
}: {
  state: Signal<AgentState>;
  className?: string;
}): preact.JSX.Element {
  return (
    <div
      class={cn(
        "inline-flex items-center justify-center gap-1.5 text-[13px] font-medium leading-[130%] text-aai-text-muted capitalize",
        className,
      )}
    >
      <div
        data-state={state.value}
        class="w-2 h-2 rounded-full data-[state=disconnected]:bg-aai-state-disconnected data-[state=connecting]:bg-aai-state-connecting data-[state=ready]:bg-aai-state-ready data-[state=listening]:bg-aai-state-listening data-[state=thinking]:bg-aai-state-thinking data-[state=speaking]:bg-aai-state-speaking data-[state=error]:bg-aai-state-error"
      />
      {state}
    </div>
  );
}
