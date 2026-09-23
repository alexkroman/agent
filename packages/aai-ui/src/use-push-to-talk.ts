// Copyright 2026 the AAI authors. MIT license.
/**
 * `usePushToTalk` — a hold-to-speak button, for an agent that declares
 * `turnDetection: "manual"`.
 *
 * The three session edges underneath (`session.userTurn`'s `start`, `commit`
 * and `clear`) are one line each; what a button needs on top of them is
 * where hand-written versions go wrong, and every one of the four is a turn
 * that is left OPEN — the microphone live and nothing ever answered:
 *
 * - **The pointer leaves.** A `mouseup` outside the button never reaches it.
 *   The handlers here capture the pointer on the way down, so the release
 *   arrives wherever it happens; an `onPointerCancel` (a scroll gesture, a
 *   system dialog) DISCARDS the turn rather than answering half a sentence.
 * - **The key repeats.** Holding a key fires `keydown` over and over, and each
 *   one would re-open the turn. Only the first counts.
 * - **The window loses focus mid-hold.** The `keyup` goes to another window
 *   and is never delivered, so the turn is committed on `blur` — what the
 *   caller would have done had the release been seen.
 * - **The component unmounts mid-hold.** The turn is discarded on the way out.
 *
 * And one that is a nuisance rather than a stuck turn: the hold key is ignored
 * while focus is in a text field, where Space is a character.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionCore, useSessionSelector } from "./context.ts";
import type { SessionSnapshot } from "./session-core-types.ts";

/** Options for {@link usePushToTalk}. */
export type UsePushToTalkOptions = {
  /**
   * The keyboard key that holds the turn open, as a `KeyboardEvent.code` —
   * `"Space"` by default, so the whole page is a walkie-talkie. `false` turns
   * the global key off; the button itself still answers Space and Enter while
   * it has focus.
   */
  holdKey?: string | false;
};

/**
 * What {@link usePushToTalk} returns.
 *
 * @public
 */
export type UsePushToTalkResult = {
  /** Whether a turn is being held open right now — the button is DOWN. */
  talking: boolean;
  /**
   * Whether pressing would do anything: the call is live. False before Start
   * and while paused, which is when a button should render disabled.
   */
  ready: boolean;
  /** Open a turn. Interrupts the agent if it is speaking. Ignored while held. */
  press: () => void;
  /** Close the turn and have the agent answer it. Ignored unless held. */
  release: () => void;
  /** Close the turn and discard it — nothing is answered. Ignored unless held. */
  cancel: () => void;
  /**
   * Spread onto a `<button>`: pointer capture, the keyboard pair, and
   * `aria-pressed`. The handlers are the whole contract — style it however you
   * like.
   */
  buttonProps: {
    onPointerDown: (event: { currentTarget: Element; pointerId: number }) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onKeyDown: (event: { key: string; repeat: boolean; preventDefault(): void }) => void;
    onKeyUp: (event: { key: string; preventDefault(): void }) => void;
    onContextMenu: (event: { preventDefault(): void }) => void;
    disabled: boolean;
    "aria-pressed": boolean;
  };
};

// Module scope for a stable selection identity — see `use-user-transcript.ts`.
const selectRunning = (snapshot: SessionSnapshot): boolean => snapshot.running;

/** True when a key event came from somewhere typing belongs. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Hold-to-speak over the session's push-to-talk methods, with the four ways a
 * turn gets stuck open handled — see this module's doc.
 *
 * Must be used inside the provider `mountClient()` installs, against an agent
 * declaring `turnDetection: "manual"`; any other agent ignores the commands and
 * its server says so once.
 *
 * @example A hold-to-talk button
 * ```tsx
 * import { usePushToTalk } from "@alexkroman1/aai-ui";
 *
 * function TalkButton() {
 *   const { talking, buttonProps } = usePushToTalk();
 *   return (
 *     <button type="button" {...buttonProps}>
 *       {talking ? "Listening… release to send" : "Hold to talk (or hold Space)"}
 *     </button>
 *   );
 * }
 * ```
 *
 * @public
 */
export function usePushToTalk(options: UsePushToTalkOptions = {}): UsePushToTalkResult {
  const holdKey = options.holdKey ?? "Space";
  // The session's own sub-handle, stable per core — push-to-talk is not one of
  // the `SessionActions` every chrome is handed, so this hook is the door.
  const { userTurn } = useSessionCore();
  const ready = useSessionSelector(selectRunning);
  const [talking, setTalking] = useState(false);
  // The source of truth for the handlers: two edges can land in one render
  // (a pointerdown and a keydown), and state would read stale for the second.
  const held = useRef(false);

  const press = useCallback((): void => {
    if (held.current || !ready) return;
    held.current = true;
    setTalking(true);
    userTurn.start();
  }, [ready, userTurn]);

  const release = useCallback((): void => {
    if (!held.current) return;
    held.current = false;
    setTalking(false);
    userTurn.commit();
  }, [userTurn]);

  const cancel = useCallback((): void => {
    if (!held.current) return;
    held.current = false;
    setTalking(false);
    userTurn.clear();
  }, [userTurn]);

  // A call that stops mid-hold (paused, ended, dropped) has no turn to hold.
  useEffect(() => {
    if (!ready && held.current) {
      held.current = false;
      setTalking(false);
    }
  }, [ready]);

  // The page-wide hold key, and the lost-`keyup` backstop.
  useEffect(() => {
    if (holdKey === false || typeof window === "undefined") return;
    const down = (event: KeyboardEvent): void => {
      if (event.code !== holdKey || event.repeat || isTypingTarget(event.target)) return;
      event.preventDefault();
      press();
    };
    const up = (event: KeyboardEvent): void => {
      if (event.code !== holdKey) return;
      event.preventDefault();
      release();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, [holdKey, press, release]);

  // Unmounted mid-hold: discard, never answer a turn nobody finished. The ref
  // holds the latest `cancel` so the cleanup runs once, on unmount only.
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => () => cancelRef.current(), []);

  const buttonProps = useMemo<UsePushToTalkResult["buttonProps"]>(
    () => ({
      onPointerDown: (event) => {
        // Captured, so the release is delivered even off the button.
        event.currentTarget.setPointerCapture?.(event.pointerId);
        press();
      },
      onPointerUp: release,
      onPointerCancel: cancel,
      onKeyDown: (event) => {
        if ((event.key !== " " && event.key !== "Enter") || event.repeat) return;
        event.preventDefault();
        press();
      },
      onKeyUp: (event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        release();
      },
      // A long press on a touch screen opens the context menu otherwise.
      onContextMenu: (event) => event.preventDefault(),
      disabled: !ready,
      "aria-pressed": talking,
    }),
    [press, release, cancel, ready, talking],
  );

  return useMemo(
    () => ({ talking, ready, press, release, cancel, buttonProps }),
    [talking, ready, press, release, cancel, buttonProps],
  );
}
