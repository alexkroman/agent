// Copyright 2026 the AAI authors. MIT license.
// The chat composer: the textarea pinned to the bottom of the chat panel, the
// queued-follow-up rows above it, and the send/stop button. Split from
// panes/chat.tsx for file-size discipline; its two callers are the live
// conversation and the pre-sandbox view that precedes it.

import clsx from "clsx";
import type { QueuedMessage } from "../chat-queue.ts";
import { DictationButton, type Transcribe, useComposerDictation } from "./dictation-button.tsx";
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
  /**
   * Speak a prompt instead of typing it: a mic button that records a clip and
   * appends its transcript to the field. Absent, or in a browser that cannot
   * record, there is no button.
   */
  transcribe?: Transcribe | undefined;
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
  transcribe,
}: ComposerProps) {
  const voice = useComposerDictation(transcribe, value, onValueChange);
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
    <div className="flex flex-none flex-col gap-2 px-2 pt-2">
      {queued.length > 0 && (
        <ul aria-label="Queued messages" className="m-0 flex list-none flex-col gap-1 p-0">
          {queued.map((item, index) => (
            <li
              key={item.id}
              className="flex items-center gap-2 rounded-lg border border-dashed border-line-strong bg-cream px-2.5 py-1.5 text-[12px] text-muted"
            >
              <span className="flex-none text-[10px] font-medium tracking-[1px] text-subtle uppercase">
                Queued
              </span>
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
      <div className={clsx("composer-card", disabled && "opacity-70")}>
        {/* A textarea, not an input: Shift+Enter for a newline is table stakes
            for prompting, and a Stop that hands several queued messages back
            (see drainText) needs a field that can hold them — a single-line
            input silently strips the newlines between them. */}
        <textarea
          className="field-sizing-content max-h-48 min-h-[52px] w-full resize-none border-none bg-transparent px-3.5 pt-3 pb-1 text-[13px] leading-5 text-fg placeholder:text-subtle focus:outline-none"
          rows={2}
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
        <div className="flex items-center justify-between gap-2 pr-2 pb-2 pl-3.5">
          <ComposerHint status={voice.status} failed={voice.dictation.error != null} busy={busy} />
          <div className="flex flex-none items-center gap-1">
            {voice.enabled && <DictationButton dictation={voice.dictation} disabled={disabled} />}
            <button
              type="button"
              aria-label={showStop ? "Stop" : "Send"}
              className={clsx("h-8 w-8", SEND_BUTTON_CLASS, showStop && "bg-fg hover:bg-ink")}
              onClick={showStop ? onStop : submit}
              disabled={!showStop && (disabled || sendDisabled)}
            >
              {showStop ? <StopIcon /> : <SendIcon />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The line under the field: what dictation is doing, else how Enter behaves. */
function ComposerHint({
  status,
  failed,
  busy,
}: {
  status: string | null;
  failed: boolean;
  busy: boolean;
}) {
  if (status !== null) {
    return (
      <span className={clsx("truncate text-[11px]", failed ? "text-err" : "text-subtle")}>
        {status}
      </span>
    );
  }
  return (
    <span className="truncate text-[11px] text-subtle">
      {busy ? "Enter queues it for after this turn" : "Shift+Enter for a new line"}
    </span>
  );
}
