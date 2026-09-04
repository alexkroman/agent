// Copyright 2026 the AAI authors. MIT license.
// The transcript half of the chat panel: one message renderer and the scroll
// container. Split from chat.tsx for file-size discipline — and because it is
// rendered TWICE: by the restored history shown the moment a project opens,
// and by the live conversation that replaces it once the sandbox is brokered.
// Sharing the layout is what makes that swap invisible; two hand-matched copies
// would shift the messages under the reader at the exact moment they land.

import { Markdown } from "@alexkroman1/aai-ui";
import type { UIMessage } from "ai";
import { memo, type ReactNode } from "react";
import { StickToBottom } from "use-stick-to-bottom";
import type { StudioStatus } from "./api.ts";
import { ChatStatusNote } from "./chat-status-note.tsx";
import { ToolRow, toBlocks } from "./tool-row.tsx";

// Memoized: while a turn streams, useChat updates dozens of times a second
// but only the streaming message's identity changes — settled messages must
// not re-run their markdown parse on every chunk.
const MessageView = memo(function MessageView({
  message,
  busy = false,
  labels,
}: {
  message: UIMessage;
  busy?: boolean;
  labels?: Record<string, string> | undefined;
}) {
  if (message.role === "user") {
    const text = message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg border border-line bg-cream px-3.5 py-2 text-[13px] leading-5 break-words whitespace-pre-wrap">
          {text}
        </div>
      </div>
    );
  }
  return (
    <div className="text-[13px] leading-[19px] break-words">
      {toBlocks(message).map((block) =>
        block.kind === "text" ? (
          <Markdown key={block.key} text={block.text} variant="compact" />
        ) : (
          <ToolRow key={block.key} part={block.part} active={busy} labels={labels} />
        ),
      )}
    </div>
  );
});

/** The "new chat" welcome bubble — shown only when the conversation is empty. */
export function EmptyStateBody({ status }: { status: StudioStatus | undefined }) {
  return (
    <>
      <div className="rounded-lg border border-line bg-cream px-[18px] py-4">
        <p className="m-0 text-[13px] leading-5">
          Welcome to AssemblyAI Build. Tell me what your voice agent should do and I'll build the
          first version.
        </p>
      </div>
      <ChatStatusNote status={status} />
    </>
  );
}

type TranscriptProps = {
  messages: readonly UIMessage[];
  /** A turn is streaming: tool rows render as in-progress. */
  busy?: boolean;
  labels?: Record<string, string> | undefined;
  /** Rendered above the messages — the empty-state welcome bubble. */
  lead?: ReactNode;
  /**
   * Rendered below the last message, inside the scroll region so it stays
   * pinned to the bottom: "Working…", a turn error, or — before the sandbox
   * is up — the "Starting sandbox…" note that gates the composer.
   */
  footer?: ReactNode;
};

/**
 * The scrolling message list.
 *
 * StickToBottom follows streamed output but releases when the user scrolls up
 * to read, re-engaging once they return to the bottom.
 */
export function Transcript({ messages, busy = false, labels, lead, footer }: TranscriptProps) {
  return (
    <StickToBottom className="min-h-0 flex-1" initial="instant" resize="smooth">
      <StickToBottom.Content className="flex flex-col gap-4 px-6 py-5">
        {lead}
        {messages.map((message) => (
          <MessageView key={message.id} message={message} busy={busy} labels={labels} />
        ))}
        {footer}
      </StickToBottom.Content>
    </StickToBottom>
  );
}
