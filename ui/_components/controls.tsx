// Copyright 2025 the AAI authors. MIT license.
import { useSession } from "../signals.ts";

export function Controls() {
  const { running, toggle, reset } = useSession();

  const btnBase =
    "h-8 px-3 py-1.5 rounded-aai text-sm font-medium leading-[130%] cursor-pointer border border-transparent outline-none";

  return (
    <div class="flex gap-2 px-4 py-3 border-t border-aai-border shrink-0">
      <button
        type="button"
        class={`${btnBase} ${
          running.value
            ? "bg-aai-surface-hover text-aai-text-secondary border-aai-border"
            : "bg-aai-surface-hover text-aai-text-secondary border-aai-border"
        }`}
        onClick={toggle}
      >
        {running.value ? "Stop" : "Resume"}
      </button>
      <button
        type="button"
        class={`${btnBase} bg-transparent text-aai-text-secondary border-aai-border`}
        onClick={reset}
      >
        New Conversation
      </button>
    </div>
  );
}
