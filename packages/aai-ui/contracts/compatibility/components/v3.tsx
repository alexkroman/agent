// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:components` epoch 3.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * **Epoch 3 ADDS `ConsoleShell` and `ConsoleShellProps`.** Nothing was removed
 * and no signature narrowed, so epochs 1 and 2 are RETAINED and both compile
 * unchanged beside this file.
 *
 * The component is not new — only its visibility is. It already had exactly the
 * right prop shape and was `@internal`, so every custom chrome rebuilt the frame
 * as well as the conversation, and every one of them re-derived the error banner
 * WITHOUT the `role="alert"` that `console-shell.tsx` argues is load-bearing:
 * once the `fatalError` latch has fired the banner is the only remaining signal,
 * the state eyebrow beside it having gone back to reading like a live session.
 * An accessibility attribute nobody re-derives correctly is a reason to publish
 * the component, not to document the attribute.
 *
 * The line to draw: reach for `ConsoleShell` when the CONVERSATION is yours and
 * the frame is not; reach for `ChatView` when both are ours.
 */

import type { ReactNode } from "react";
import {
  type AgentState,
  ConsoleShell,
  type ConsoleShellProps,
  Controls,
  type ControlsProps,
  Markdown,
  type MarkdownProps,
  MessageList,
  type MessageListProps,
} from "../../../index.ts";

/** Unchanged from epoch 2: a wrapper that forwards the component's own props. */
export function Prose(props: MarkdownProps) {
  return <Markdown {...props} />;
}

/** Unchanged from epoch 2: `text` is REQUIRED, and the type says so. */
export const greeting: MarkdownProps = { text: "**Ready.**", variant: "compact" };

/** Unchanged from epoch 2: the two container components, each with its props type. */
export function Chrome({ list, controls }: { list: MessageListProps; controls: ControlsProps }) {
  return (
    <div className="flex h-full flex-col">
      <MessageList {...list} />
      <Controls {...controls} />
    </div>
  );
}

/**
 * New at epoch 3: our frame around a conversation the page renders itself. The
 * banner, the eyebrow and the pulse come with the shell; what goes inside is
 * entirely the page's.
 */
export function Board({
  state,
  error,
  rows,
}: {
  state: AgentState;
  error: string | null;
  rows: ReactNode;
}) {
  return (
    <ConsoleShell
      icon="🚒"
      title="Dispatch"
      state={state}
      pulsing={state === "speaking"}
      error={error}
      footer={<Controls />}
    >
      {rows}
    </ConsoleShell>
  );
}

/**
 * And the props are nameable, so a chrome that computes them elsewhere annotates
 * the bag instead of restating eight fields. `error` accepts `null` as well as
 * `undefined` on purpose — a page holding "no error" as `null` should not have
 * to translate it at the boundary.
 */
export const frame: ConsoleShellProps = {
  state: "listening",
  pulsing: false,
  error: null,
  children: null,
  footer: null,
};
