// Copyright 2025 the AAI authors. MIT license.

import type { Signal } from "@preact/signals";
import type * as preact from "preact";
import type { AgentState } from "../types.ts";

export function StateIndicator({ state }: { state: Signal<AgentState> }): preact.JSX.Element {
  return (
    <div class="inline-flex items-center justify-center gap-1.5 text-[13px] font-medium leading-[130%] text-aai-text-muted capitalize">
      <div
        class="w-2 h-2 rounded-full"
        style={{ background: `var(--color-aai-state-${state.value})` }}
      />
      {state}
    </div>
  );
}
