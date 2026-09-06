// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import { Fragment, type ReactNode } from "react";
import { useSessionControls } from "../use-session-controls.ts";
import { Button, type ButtonVariant } from "./button.tsx";

/**
 * Which of the four buttons a {@link SessionControlButton} is.
 *
 * @public
 */
export type SessionControlAction = "start" | "toggle" | "restart" | "end";

/**
 * One button of {@link SessionControls}, as handed to `renderButton`.
 *
 * @public
 */
export type SessionControlButton = {
  /** Which button this is. A custom renderer switches on it for its look. */
  action: SessionControlAction;
  /** The label to show — the caller's own word, or the default. */
  label: string;
  /** The handler. Already bound; wire it to `onClick` as it is. */
  onClick: () => void;
  /**
   * Whether the call is live. Meaningful on `toggle`, whose label already says
   * which way it will flip, and handed to every button so a renderer can dim
   * the others while paused.
   */
  running: boolean;
};

/**
 * The five words {@link SessionControls} renders, every one overridable.
 *
 * @public
 */
export type SessionControlsLabels = {
  /** The button shown before the call starts. Default `"Start"`. */
  start: string;
  /** The toggle's label while running. Default `"Pause"`. */
  pause: string;
  /** The toggle's label while paused. Default `"Resume"`. */
  resume: string;
  /** Hang up and dial again. Default `"New Conversation"`. */
  restart: string;
  /** Hang up. Default `"End"`. */
  end: string;
};

const DEFAULT_LABELS: SessionControlsLabels = {
  start: "Start",
  pause: "Pause",
  resume: "Resume",
  restart: "New Conversation",
  end: "End",
};

/**
 * Props of {@link SessionControls}.
 *
 * @public
 */
export type SessionControlsProps = {
  /** The words this chrome has its own term for; the rest keep the defaults. */
  labels?: Partial<SessionControlsLabels> | undefined;
  /**
   * Renders one button. Absent, each is a stock {@link Button}. A chrome
   * with its own look renders its own `<button>` from the
   * {@link SessionControlButton} it is handed — the component still decides
   * WHICH buttons exist and what each one does.
   */
  renderButton?: ((button: SessionControlButton) => ReactNode) | undefined;
  /** Additional CSS class names for the row, appended to its own layout classes. */
  className?: string | undefined;
  /** Rendered after the buttons — a count, a spacer, a status line. */
  children?: ReactNode;
};

const DEFAULT_VARIANT: Readonly<Record<SessionControlAction, ButtonVariant>> = {
  start: "default",
  toggle: "secondary",
  restart: "ghost",
  end: "secondary",
};

function defaultButton({ action, label, onClick }: SessionControlButton): ReactNode {
  return (
    <Button variant={DEFAULT_VARIANT[action]} onClick={onClick}>
      {label}
    </Button>
  );
}

/**
 * The full control row of a custom chrome: **Start** before the call, then
 * **Pause / Resume**, **New Conversation** and **End** once it is up.
 *
 * {@link Controls} is the stock console's footer — Stop/Resume and New
 * Conversation, with the URL chips — and it has no Start branch and no End,
 * because the default shell shows a start SCREEN and a session there ends by
 * closing the tab. A chrome that owns its whole frame has no start screen, so
 * three of them each wrote this row: the same `!started` branch, the same
 * three buttons behind it, and the same twelve-line comment on why the middle
 * one is `end(); start()` and not `reset()`. The buttons' look is the
 * chrome's — `renderButton` — and everything else is here once.
 *
 * **Why `restart` is `end()` then `start()`, and never `reset()`.** `reset()`
 * clears the transcript and reconnects carrying the same session id, so every
 * `sessionSlot` on the agent survives: a caller who pressed "New Conversation"
 * on a stateful agent got a blank transcript in front of their old cart, game
 * or incident board, with nothing on screen saying so, and the next tool call
 * repopulated it. `end()` drops the resume identity, so the redial is a
 * brand-new session — fresh state, greeting included — and `start()` puts the
 * chrome straight back on the call rather than at its Start button.
 *
 * **Why End is `end()`.** It hangs up and flips `started` back, so the row
 * returns to its Start button and the next start is a new session. `reset()`
 * would keep the call live — the buttons never toggle back.
 *
 * Reads the session through {@link useSessionControls}: two one-field
 * subscriptions, so the row re-renders when a flag flips and not on every
 * transcript partial.
 *
 * @example A board's controls in its own colours, with a trailing count
 * ```tsx
 * import { SessionControls } from "@alexkroman1/aai-ui";
 *
 * const BUTTON = "px-4 py-2 rounded-md text-xs font-semibold cursor-pointer";
 *
 * function ShiftControls({ logged }: { logged: number }) {
 *   return (
 *     <SessionControls
 *       labels={{ start: "Start Dispatch", end: "End Shift" }}
 *       renderButton={({ action, label, onClick }) => (
 *         <button
 *           type="button"
 *           className={BUTTON}
 *           style={{ background: action === "end" ? "#dc2626" : "#2563eb", color: "white" }}
 *           onClick={onClick}
 *         >
 *           {label}
 *         </button>
 *       )}
 *     >
 *       <span className="ml-auto text-[10px]">{logged} incidents logged</span>
 *     </SessionControls>
 *   );
 * }
 * ```
 *
 * @param props - See {@link SessionControlsProps}.
 *
 * @public
 */
export function SessionControls({
  labels,
  renderButton = defaultButton,
  className,
  children,
}: SessionControlsProps): ReactNode {
  const { started, running, start, toggle, restart, end } = useSessionControls();
  const words: SessionControlsLabels = { ...DEFAULT_LABELS, ...labels };

  const buttons: SessionControlButton[] = started
    ? [
        { action: "toggle", label: running ? words.pause : words.resume, onClick: toggle, running },
        { action: "restart", label: words.restart, onClick: restart, running },
        { action: "end", label: words.end, onClick: end, running },
      ]
    : [{ action: "start", label: words.start, onClick: start, running }];

  return (
    // `flex-wrap`, for the reason `Controls` gives: a row that cannot shrink
    // hands a small phone a horizontal scrollbar.
    <div className={clsx("flex flex-wrap items-center gap-2", className)}>
      {buttons.map((button) => (
        <Fragment key={button.action}>{renderButton(button)}</Fragment>
      ))}
      {children}
    </div>
  );
}
