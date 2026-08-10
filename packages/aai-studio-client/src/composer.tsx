// Copyright 2026 the AAI authors. MIT license.
// The chat composer: the textarea pinned to the bottom of the chat panel, the
// queued-follow-up rows above it, and the send/stop button. Split from
// chat.tsx for file-size discipline; its two callers are the live
// conversation and the pre-sandbox view that precedes it.

import clsx from "clsx";
import type { QueuedMessage } from "./chat-queue.ts";
import { isEnterSubmit, SEND_BUTTON_CLASS, SendIcon, StopIcon } from "./send-button.tsx";

type ComposerProps = {
  disabled: boolean;
  /**
   * The message cannot be sent YET, though the field stays live so it can be
   * written while the wait runs out (the sandbox is still starting). Distinct
   * from `disabled`, which is the LLM being unreachable: there is nothing to
   * type ahead for, so the field itself goes dead.
   */
  sendDisabled?: boolean;
  placeholder: string;
  /** Controlled input — the parent owns it so a Stop can drain the queue into it. */
  value: string;
  onValueChange: (value: string) => void;
  onSend: (text: string) => void;
  /** A turn is in flight: the send button becomes a Stop button. */
  busy?: boolean;
  /** Cancel the in-flight turn. Required whenever `busy` can be true. */
  onStop?: () => void;
  /** Follow-ups waiting for the current turn to finish, oldest first. */
  queued?: readonly QueuedMessage[];
  onRemoveQueued?: (id: string) => void;
};

/**
 * Composer pinned to the panel bottom (1b spec). Exported for tests.
 *
 * The input stays live while a turn streams — submitting then QUEUES the
 * message (the parent decides; see `hasPendingWork`) instead of it being
 * swallowed, which is what the disabled input used to do to anyone who thought
 * of a follow-up mid-turn.
 *
 * The button still swaps to Stop for the whole time a turn is in flight, even
 * with text in the input: it is the one escape hatch when a tool call is
 * taking forever, so it must be unconditionally reachable. Enter is what
 * queues — the placeholder says so, and the queued rows above make the
 * mechanism visible once something is in there.
 */
export function Composer({
  disabled,
  sendDisabled = false,
  placeholder,
  value,
  onValueChange,
  onSend,
  busy = false,
  onStop,
  queued = [],
  onRemoveQueued,
}: ComposerProps) {
  const submit = () => {
    const text = value.trim();
    // `sendDisabled` returns WITHOUT clearing the field: the text is the
    // thing being held back, so a submit that lands early has to leave it
    // where the user can send it themselves a moment later.
    if (!text || disabled || sendDisabled) return;
    onValueChange("");
    onSend(text);
  };
  const showStop = busy && onStop != null;
  return (
    <div className="flex flex-none flex-col gap-2 border-t border-line px-5 pt-4 pb-5">
      {queued.length > 0 && (
        <ul aria-label="Queued messages" className="m-0 flex list-none flex-col gap-1 p-0">
          {queued.map((item, index) => (
            <li
              key={item.id}
              className="flex items-center gap-2 rounded-md border border-dashed border-line-strong bg-cream px-2.5 py-1.5 text-[12px] text-muted"
            >
              <span className="min-w-0 flex-1 truncate">{item.text}</span>
              <button
                type="button"
                aria-label={`Remove queued message ${index + 1}`}
                className="flex-none cursor-pointer border-none bg-transparent p-0 text-[14px] leading-none text-subtle hover:text-fg"
                onClick={() => onRemoveQueued?.(item.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        {/* A textarea, not an input: Shift+Enter for a newline is table stakes
            for prompting, and a Stop that hands several queued messages back
            (see drainText) needs a field that can hold them — a single-line
            input silently strips the newlines between them. */}
        <textarea
          className="field field-sizing-content max-h-40 min-h-10 min-w-0 flex-1 resize-none border-line-strong py-2.5"
          rows={1}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (isEnterSubmit(e)) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={disabled}
          placeholder={placeholder}
        />
        <button
          type="button"
          aria-label={showStop ? "Stop" : "Send"}
          className={clsx("h-10 w-10", SEND_BUTTON_CLASS)}
          onClick={showStop ? onStop : submit}
          disabled={!showStop && (disabled || sendDisabled)}
        >
          {showStop ? <StopIcon /> : <SendIcon />}
        </button>
      </div>
    </div>
  );
}
