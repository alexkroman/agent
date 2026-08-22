// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:components` epoch 2.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * Epoch 2 NAMED the props of the three memoized components — `MarkdownProps`,
 * `ControlsProps`, `MessageListProps`. Nothing a caller writes changed, which
 * is why epoch 1 is retained and `./v1.tsx` compiles unchanged beside this
 * file; the addition is that a custom chrome can now annotate a wrapper's own
 * props with the component's, instead of restating the shape. This file covers
 * that.
 */

import {
  Controls,
  type ControlsProps,
  Markdown,
  type MarkdownProps,
  MessageList,
  type MessageListProps,
} from "../../../index.ts";

/** A wrapper that forwards the component's own props rather than restating them. */
export function Prose(props: MarkdownProps) {
  return <Markdown {...props} />;
}

/** `text` is REQUIRED, and naming the type is what says so at a call site. */
export const greeting: MarkdownProps = { text: "**Ready.**", variant: "compact" };

/** The two container components, each with its own props type. */
export function Chrome({ list, controls }: { list: MessageListProps; controls: ControlsProps }) {
  return (
    <div className="flex h-full flex-col">
      <MessageList {...list} />
      <Controls {...controls} />
    </div>
  );
}
