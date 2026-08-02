// Copyright 2026 the AAI authors. MIT license.
// The send affordance shared by the hero prompt box and the chat composer:
// the indigo action button, its arrow/stop icons, and the Enter-to-submit
// keyboard guard.

import clsx from "clsx";
import type { KeyboardEvent } from "react";

/**
 * True when Enter should submit. `isComposing` means Enter is confirming an
 * IME candidate, not the message — every text input must honor it.
 */
export function isEnterSubmit(e: KeyboardEvent): boolean {
  return e.key === "Enter" && !e.nativeEvent.isComposing;
}

/** The indigo icon-button shell (size comes from the caller: h-9/h-10). */
export const SEND_BUTTON_CLASS =
  "flex flex-none cursor-pointer items-center justify-center rounded-sm border-none bg-indigo text-white hover:bg-indigo-hover disabled:cursor-not-allowed disabled:bg-disabled disabled:text-line-strong";

export function SendIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
    >
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

type SendButtonProps = {
  onClick: () => void;
  disabled: boolean;
  /** Size classes, e.g. "h-9 w-9". */
  className: string;
};

/** The plain send button (the chat composer's morphs into Stop instead). */
export function SendButton({ onClick, disabled, className }: SendButtonProps) {
  return (
    <button
      type="button"
      aria-label="Send"
      className={clsx(className, SEND_BUTTON_CLASS)}
      onClick={onClick}
      disabled={disabled}
    >
      <SendIcon />
    </button>
  );
}
