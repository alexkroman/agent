// Copyright 2026 the AAI authors. MIT license.
// Copy-to-clipboard with a per-item flash on the button that triggered it.
//
// Shared because two Settings cards hand the user a string to paste into
// something else — the CLI commands and the phone webhook URLs — and both
// need the same three things the naive version gets wrong: the flash is keyed
// by the copied TEXT (so one row's "Copied" does not light up every button),
// there is at most one live timer (a second click otherwise leaves the first
// timeout to clear the second flash early), and the timer is cleared on
// unmount.

import { useEffect, useRef, useState } from "react";

/** How long a button shows its outcome before returning to "Copy". */
const FLASH_MS = 1500;

type CopyState = { text: string; ok: boolean };

export type Copier = {
  /** Copy `text`, flashing the button that owns it. */
  copy: (text: string) => void;
  /** The button label for `text` — "Copy", "Copied", or "Failed". */
  label: (text: string) => string;
  /** True when `text` was the last thing copied, successfully. */
  didCopy: (text: string) => boolean;
};

export function useCopy(): Copier {
  const [copied, setCopied] = useState<CopyState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // One live timer at a time, and none after unmount.
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = (text: string): void => {
    const flash = (ok: boolean): void => {
      setCopied({ text, ok });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), FLASH_MS);
    };
    // No clipboard in an insecure context (and none in jsdom) — the text is
    // on screen either way, so a failure only changes the button label.
    const write = navigator.clipboard?.writeText(text);
    if (!write) {
      flash(false);
      return;
    }
    void write.then(
      () => flash(true),
      () => flash(false),
    );
  };

  const label = (text: string): string => {
    if (copied?.text !== text) return "Copy";
    return copied.ok ? "Copied" : "Failed";
  };

  return {
    copy,
    label,
    didCopy: (text) => copied?.text === text && copied.ok,
  };
}
