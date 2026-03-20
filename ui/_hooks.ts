// Copyright 2025 the AAI authors. MIT license.

import { useSignalEffect } from "@preact/signals";
import type { RefObject } from "preact";
import { useRef } from "preact/hooks";
import { useSession } from "./signals.ts";

/**
 * Auto-scroll a container to the bottom when messages, tool calls,
 * or utterances change. Returns a ref to attach to a sentinel `<div>`
 * at the bottom of the scrollable area.
 *
 * @example
 * ```tsx
 * function MyChat() {
 *   const bottomRef = useAutoScroll();
 *   return (
 *     <div class="overflow-y-auto">
 *       {messages.map((m, i) => <p key={i}>{m.text}</p>)}
 *       <div ref={bottomRef} />
 *     </div>
 *   );
 * }
 * ```
 */
export function useAutoScroll(): RefObject<HTMLDivElement | null> {
  const { session } = useSession();
  const ref = useRef<HTMLDivElement | null>(null);

  useSignalEffect(() => {
    session.messages.value;
    session.toolCalls.value;
    session.userUtterance.value;
    session.agentUtterance.value;
    ref.current?.scrollIntoView({ behavior: "smooth" });
  });

  return ref;
}
