// Copyright 2026 the AAI authors. MIT license.
/**
 * A value that shows itself for a moment and then goes away — the "Copied" on a
 * copy button, the "saved" under the editor.
 *
 * Shared because both were the same three-line primitive with the same 1500ms
 * and the same three-line comment explaining the same two things the naive
 * version gets wrong: there must be at most ONE live timer (a second flash
 * otherwise has its window cut short by the first one's timeout), and the timer
 * has to be cleared on unmount.
 */

import { useEffect, useRef, useState } from "react";

/** How long a flashed value stays up. The one duration both callers used. */
const FLASH_MS = 1500;

export type Flash<T> = {
  /** What is being shown right now, or `null` between flashes. */
  readonly value: T | null;
  /** Show `value` for `ms`, replacing (and re-arming) any flash already up. */
  readonly flash: (value: T) => void;
};

export function useFlash<T>(ms: number = FLASH_MS): Flash<T> {
  const [value, setValue] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // One live timer at a time, and none after unmount.
  useEffect(() => () => clearTimeout(timer.current), []);

  const flash = (next: T): void => {
    setValue(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setValue(null), ms);
  };

  return { value, flash };
}
