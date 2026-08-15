// Copyright 2026 the AAI authors. MIT license.
// Copy-to-clipboard with a per-item flash on the button that triggered it.
//
// Shared because two Settings cards hand the user a string to paste into
// something else — the CLI commands and the phone webhook URLs — and both
// need the same thing the naive version gets wrong: the flash is keyed by the
// copied TEXT, so one row's "Copied" does not light up every button. The
// single-timer / clear-on-unmount half is `useFlash`, which the editor's save
// note shares.

import { useFlash } from "./use-flash.ts";

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
  const { value: copied, flash } = useFlash<CopyState>();

  const copy = (text: string): void => {
    // No clipboard in an insecure context (and none in jsdom) — the text is
    // on screen either way, so a failure only changes the button label.
    const write = navigator.clipboard?.writeText(text);
    if (!write) {
      flash({ text, ok: false });
      return;
    }
    void write.then(
      () => flash({ text, ok: true }),
      () => flash({ text, ok: false }),
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
