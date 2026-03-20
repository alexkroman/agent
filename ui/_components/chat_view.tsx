// Copyright 2025 the AAI authors. MIT license.
import type * as preact from "preact";
import { useMountConfig } from "../mount_context.ts";
import { useSession } from "../signals.ts";
import { Controls } from "./controls.tsx";
import { ErrorBanner } from "./error_banner.tsx";
import { MessageList } from "./message_list.tsx";
import { StateIndicator } from "./state_indicator.tsx";

export function ChatView(): preact.JSX.Element {
  const { session } = useSession();
  const { title } = useMountConfig();

  return (
    <div class="flex flex-col h-screen max-w-130 mx-auto bg-aai-bg text-aai-text font-aai text-sm">
      {/* Header */}
      <div class="flex items-center gap-3 px-4 py-3 border-b border-aai-border shrink-0">
        <span class="text-sm font-semibold text-aai-primary">{title ?? "aai"}</span>
        <div class="ml-auto">
          <StateIndicator state={session.state} />
        </div>
      </div>
      <ErrorBanner error={session.error} />
      <MessageList />
      <Controls />
    </div>
  );
}
