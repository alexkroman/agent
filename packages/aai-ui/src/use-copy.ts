// Copyright 2026 the AAI authors. MIT license.
/**
 * Copy-to-clipboard with a per-item flash on the button that triggered it.
 *
 * Anywhere a UI hands the reader a string to paste somewhere else — a session
 * URL, a webhook, a `curl` line — the button wants the same three things, and
 * two of them are easy to get wrong:
 *
 * - The flash is keyed by the copied TEXT, so one row's "Copied" does not light
 *   up every button beside it.
 * - A FAILED write is reported rather than swallowed. There is no clipboard in
 *   an insecure context, and a browser may refuse the permission; a `catch`
 *   that does nothing leaves a button that visibly does nothing when clicked,
 *   which reads as a broken page rather than as a blocked capability.
 * - The single-timer / clear-on-unmount half is {@link useFlash}'s.
 */

import { type UseFlashResult, useFlash } from "./use-flash.ts";

/** Which text was copied, and whether the write succeeded. */
type CopyState = { text: string; ok: boolean };

/**
 * What {@link useCopy} hands back — the click handler and the two readings a
 * button needs off one shared flash.
 *
 * @public
 */
export type UseCopyResult = {
  /** Copy `text`, flashing the button that owns it. */
  copy: (text: string) => void;
  /**
   * The button label for `text` — `idle` until it is clicked, then `"Copied"`
   * or `"Failed"` for the length of the flash.
   *
   * Only the idle word is the caller's: it is the button's NAME (`"Copy"`,
   * `"UI"`, `"Webhook URL"`), where the other two are the OUTCOME and are the
   * one bit of state a reader can see. A caller wanting other words for those
   * reads {@link UseCopyResult.didCopy} and writes its own.
   */
  label: (text: string, idle?: string) => string;
  /** True when `text` was the last thing copied, successfully. */
  didCopy: (text: string) => boolean;
};

/**
 * One copier for a group of copy buttons.
 *
 * @remarks
 * Call it ONCE per group and pass the {@link UseCopyResult} down, rather than once per
 * button: the flash is shared, so clicking a second row clears the first row's
 * "Copied" — which is what makes a list of URLs readable, since two rows
 * claiming to be on the clipboard is a lie about one of them.
 *
 * A chip whose idle text is its own name rather than the word "Copy" passes
 * that name to {@link UseCopyResult.label}; the two outcome words are fixed, for the
 * reason that member's own doc gives.
 *
 * @example
 * ```tsx
 * import { useCopy } from "@alexkroman1/aai-ui";
 *
 * function UrlList({ urls }: { urls: readonly string[] }) {
 *   const copier = useCopy();
 *   return (
 *     <ul>
 *       {urls.map((url) => (
 *         <li key={url}>
 *           <code>{url}</code>
 *           <button type="button" onClick={() => copier.copy(url)}>
 *             {copier.label(url)}
 *           </button>
 *         </li>
 *       ))}
 *     </ul>
 *   );
 * }
 * ```
 *
 * @public
 */
export function useCopy(): UseCopyResult {
  const { value: copied, flash }: UseFlashResult<CopyState> = useFlash<CopyState>();

  const copy = (text: string): void => {
    // No clipboard in an insecure context (and none in jsdom) — the text is on
    // screen either way, so a failure only changes the button label. It has to
    // change it: a silent no-op is indistinguishable from a broken button.
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

  const label = (text: string, idle = "Copy"): string => {
    if (copied?.text !== text) return idle;
    return copied.ok ? "Copied" : "Failed";
  };

  return {
    copy,
    label,
    didCopy: (text) => copied?.text === text && copied.ok,
  };
}
