// Copyright 2026 the AAI authors. MIT license.
/**
 * A value that shows itself for a moment and then goes away.
 *
 * The "Copied" on a copy button, the "Saved" under an editor, the "Sent" on a
 * submit. There were three hand-rolled copies of this — two in the studio
 * front-end and one inside this package's own URL chips — each with the same
 * 1500ms and the same comment explaining the same two things the naive version
 * gets wrong. It is one primitive now, and it is PUBLIC because a custom chrome
 * is exactly the caller that needs it: the moment a client renders its own copy
 * button or its own save note, it is writing the timer again.
 */

import { useEffect, useRef, useState } from "react";

/** How long a flashed value stays up. The one duration every caller used. */
const FLASH_MS = 1500;

/**
 * What {@link useFlash} hands back.
 *
 * @typeParam T - What is being flashed. A `string` for a label; a record for a
 *   flash that has to say WHICH thing it belongs to, as `useCopy` does.
 *
 * @public
 */
export type UseFlashResult<T> = {
  /** What is being shown right now, or `null` between flashes. */
  readonly value: T | null;
  /** Show `value` for the hook's duration, replacing any flash already up. */
  readonly flash: (value: T) => void;
};

/**
 * A transient value: set it, and it clears itself after `ms`.
 *
 * @remarks
 * The two things this holds that a `useState` plus a `setTimeout` at the call
 * site reliably gets wrong:
 *
 * - **At most ONE live timer.** A second flash while the first is still up
 *   re-arms rather than stacking, so the new value gets its full window
 *   instead of being cleared early by the previous click's timeout.
 * - **Nothing fires after unmount.** The timer is cleared on teardown, so a
 *   chip clicked and then scrolled out of the tree does not `setState` on a
 *   component React has already thrown away.
 *
 * @example
 * ```tsx
 * import { useFlash } from "@alexkroman1/aai-ui";
 *
 * function SaveNote({ onSave }: { onSave: () => Promise<void> }) {
 *   const { value: note, flash } = useFlash<string>();
 *   return (
 *     <button type="button" onClick={() => void onSave().then(() => flash("Saved"))}>
 *       {note ?? "Save"}
 *     </button>
 *   );
 * }
 * ```
 *
 * @typeParam T - What is being flashed.
 * @param ms - How long the value stays up. Defaults to 1500ms, which is what
 *   every caller wanted: long enough to read a word, short enough that the
 *   control is back to its real label before the reader looks again.
 *
 * @public
 */
export function useFlash<T>(ms: number = FLASH_MS): UseFlashResult<T> {
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
