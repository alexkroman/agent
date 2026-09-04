// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ReactNode } from "react";
import { useSessionError } from "../context.ts";
import { ERROR_COLOR } from "./_colors.ts";

/**
 * Props of {@link SessionErrorBanner}.
 *
 * Every field is optional, so `<SessionErrorBanner />` is the whole call. It is
 * a NAMED type all the same, for the reason `ControlsProps` and
 * `ConsoleShellProps` are: an inline object literal in the signature leaves a
 * `createElement(SessionErrorBanner, { className })` caller unable to infer the
 * props at all, and gives the reference page nothing to link to.
 *
 * @public
 */
export type SessionErrorBannerProps = {
  /** Additional CSS class names for the banner, appended to its own. */
  className?: string | undefined;
};

/**
 * The announced banner for a failed session: the error's message and code, or
 * nothing at all when the session is fine.
 *
 * **This used to be four lines inside `ConsoleShell`, and that is why it is its
 * own component.** The banner was the reason `ConsoleShell` was published —
 * `role="alert"` is the one part of that component a reviewer cannot see is
 * missing, since per the `fatalError` latch in `session-core.ts` the banner is
 * the ONLY remaining signal a session died (the state eyebrow beside it goes
 * back to reading like a live session), and a screen reader is never told an
 * unannounced one appeared. But `ConsoleShell` is a whole FRAME: a centred
 * `max-w-190` column with its own header and footer. Every full-bleed chrome —
 * a two-pane board, a CRT — therefore could not adopt it, rebuilt the banner
 * instead, and the three that did had ALREADY drifted: one rendered
 * `ERROR: {message}` and dropped the code entirely, one `ERROR: {message}
 * ({code})`, one `{message} ({code})`. Splitting the banner out is what lets a
 * chrome take the announced-error decision without taking the layout, and
 * `ConsoleShell` composes this rather than keeping a second copy, so the two
 * cannot drift again.
 *
 * **It reads the session itself.** There is no `error` prop: a banner that
 * takes its text from the caller is a banner a caller can forget to wire, which
 * is exactly the failure above with an extra step. It subscribes narrowly via
 * {@link useSessionError}, so a page that renders it does not re-render with
 * the transcript.
 *
 * **The code is shown, always.** `SessionError.code` is the eight-member wire
 * union — it is what a user pastes into a bug report and the only part of the
 * error that is stable across wordings — and the chrome that dropped it left
 * its readers with a sentence and no way to say which failure it was.
 *
 * Must be rendered inside the providers `client()` installs.
 *
 * @example A full-bleed chrome that wants the banner and not the frame
 * ```tsx
 * import { SessionErrorBanner } from "@alexkroman1/aai-ui";
 *
 * function Board() {
 *   return (
 *     <div className="grid grid-cols-[1fr_320px] h-screen">
 *       <main>…</main>
 *       <aside>…</aside>
 *       <SessionErrorBanner className="col-span-2" />
 *     </div>
 *   );
 * }
 * ```
 *
 * @param props - See {@link SessionErrorBannerProps}.
 *
 * @public
 */
export function SessionErrorBanner({ className }: SessionErrorBannerProps): ReactNode {
  const error = useSessionError();
  if (!error) return null;
  return (
    <div
      role="alert"
      // `shrink-0` travels with the banner: its first home is a flex column
      // (`ConsoleShell`), where a banner allowed to shrink loses its second
      // line before anything else on the page does. It is inert in any other
      // layout, which is the cheaper half of the trade.
      className={clsx(
        "px-3.5 py-2.5 rounded-aai border text-[13px] leading-[130%] shrink-0",
        className,
      )}
      style={{
        borderColor: "rgba(179,38,30,0.35)",
        background: "rgba(179,38,30,0.06)",
        color: ERROR_COLOR,
      }}
    >
      {error.message} ({error.code})
    </div>
  );
}
