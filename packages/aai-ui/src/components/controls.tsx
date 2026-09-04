// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import { type FunctionComponent, type MemoExoticComponent, memo } from "react";
import { useSessionCore, useSessionSelector } from "../context.ts";
import { Button } from "./button.tsx";
import { SessionUrlChips } from "./url-chips.tsx";

/**
 * Props of {@link Controls}.
 *
 * @public
 */
export type ControlsProps = {
  /**
   * Additional CSS class names, appended to the container's own layout
   * classes rather than replacing them.
   */
  className?: string;
};

/**
 * Session control buttons: **Stop / Resume** and **New Conversation**.
 *
 * Reads session state from {@link useSession}. Must be rendered inside a
 * `SessionProvider`.
 *
 * @example
 * ```tsx
 * import { Controls } from "@alexkroman1/aai-ui";
 *
 * function Footer() {
 *   return <Controls className="justify-end" />;
 * }
 * ```
 *
 * @param props - Container props.
 *
 * @public
 */
// memo(): the only prop is a string, so ChatView re-rendering (state flips,
// errors) never cascades here; the narrow `running` subscription below stays
// the sole re-render trigger.
export const Controls: MemoExoticComponent<FunctionComponent<ControlsProps>> = memo(
  function Controls({ className }: ControlsProps) {
    // Narrow subscription: only re-render when `running` flips, not on every
    // snapshot change (messages, transcripts, audio state, ...).
    const running = useSessionSelector((s) => s.running);
    const { toggle, restart } = useSessionCore();

    return (
      // `flex-wrap`, because the row could not shrink: two nowrap buttons plus
      // the chips measured 360px against a 320px viewport, so the whole page
      // picked up a horizontal scrollbar on a small phone.
      <div className={clsx("flex flex-wrap items-center gap-3 shrink-0", className)}>
        <Button variant="secondary" onClick={toggle}>
          {running ? "Stop" : "Resume"}
        </Button>
        {/*
         * `restart`, NOT `reset`. `reset` clears the transcript and reconnects
         * carrying the same session id, so every `sessionSlot` on the server
         * survives — a caller who pressed this on a stateful agent got a blank
         * transcript in front of their old cart, game or board, with nothing on
         * screen saying so. Three templates with custom chrome each found this
         * and wrote `end(); start();` by hand; the ones using this shell had no
         * way to. `restart` is that pair, and it is what the label promises.
         */}
        <Button variant="ghost" onClick={restart}>
          New Conversation
        </Button>
        {/*
         * Below `sm` the chips take a line of their own rather than sharing one
         * with the buttons. Squeezed onto the same row they truncated down to
         * their bare labels ("UI http…", "API wss…"), dropping the URL that is
         * the entire point of the chip — and the `title` tooltip that still
         * carried it is not something a touch device can open.
         */}
        <SessionUrlChips className="basis-full sm:basis-auto sm:ml-auto sm:max-w-[60%]" />
      </div>
    );
  },
);
