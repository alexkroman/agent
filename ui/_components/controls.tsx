// Copyright 2025 the AAI authors. MIT license.
import { cn } from "../_cn.ts";
import { useSession } from "../signals.ts";
import { Button } from "./button.tsx";

export function Controls({ className }: { className?: string }) {
  const { running, toggle, reset } = useSession();

  return (
    <div class={cn("flex gap-2 px-4 py-3 border-t border-aai-border shrink-0", className)}>
      <Button variant="secondary" onClick={toggle}>
        {running.value ? "Stop" : "Resume"}
      </Button>
      <Button variant="ghost" onClick={reset}>
        New Conversation
      </Button>
    </div>
  );
}
