// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { CSSProperties, ReactNode } from "react";
import { StickToBottom } from "use-stick-to-bottom";

/**
 * A scroll container that stays pinned to the bottom as its content grows,
 * releases when the reader scrolls up, and re-engages once they return to the
 * bottom.
 *
 * For clients that render their own chat chrome instead of using
 * {@link MessageList} — a terminal, a dispatch board, a themed transcript.
 * `MessageList` already behaves this way; this is the same mechanism with no
 * opinion about what goes inside it.
 *
 * @remarks
 * The pattern this replaces is a `useEffect` that calls
 * `ref.current?.scrollIntoView()` on every message change. That version has
 * three faults, and they compound: it fights the reader, since scrolling up to
 * re-read is undone by the next transcript delta; it misses growth that is not
 * a new message, because a streamed reply, an expanding tool block or a
 * markdown reflow changes height without changing the dependency array; and it
 * needs a synthetic dependency (`messages.length + transcript.length`) to fire
 * at all, which is where the dead `if (version < 0) return;` line comes from.
 * A `ResizeObserver` on the content — what this uses — has none of those.
 *
 * @example
 * ```tsx
 * import { AutoScroll, useSession } from "@alexkroman1/aai-ui";
 *
 * function Transcript() {
 *   const session = useSession();
 *   return (
 *     <AutoScroll className="flex-1 min-h-0" contentClassName="flex flex-col gap-2 p-4">
 *       {session.messages.map((m) => (
 *         <div key={m.id}>{m.content}</div>
 *       ))}
 *     </AutoScroll>
 *   );
 * }
 * ```
 *
 * @param props - Scroll container props.
 *
 * @public
 */
export function AutoScroll({
  children,
  className,
  contentClassName,
  scrollClassName = "overflow-y-auto [scrollbar-width:none]",
  style,
  initial = "instant",
  resize = "smooth",
}: {
  /** The scrollable content. */
  children: ReactNode;
  /**
   * Classes for the outer container, appended to its own.
   *
   * **The container must end up with a bounded height** (`flex-1 min-h-0`,
   * `h-full`, a fixed height). This is the one constraint callers get wrong:
   * an unbounded container grows with its content and never scrolls, so
   * nothing pins and the component silently does nothing.
   */
  className?: string | undefined;
  /**
   * Classes for the inner content element, where padding and the children's
   * own layout belong.
   */
  contentClassName?: string | undefined;
  /**
   * Classes for the scrolling element itself. Defaults to hiding the
   * scrollbar; pass `"overflow-y-auto"` to show a native one.
   */
  scrollClassName?: string | undefined;
  /** Inline styles for the outer container. */
  style?: CSSProperties | undefined;
  /**
   * Scroll behavior on mount. Defaults to `"instant"` — start at the latest
   * content without animating a scroll the reader did not ask for.
   */
  initial?: "instant" | "smooth" | undefined;
  /** Scroll behavior when pinned content grows. Defaults to `"smooth"`. */
  resize?: "instant" | "smooth" | undefined;
}): ReactNode {
  return (
    <StickToBottom
      role="log"
      className={clsx("flex-1 min-h-0", className)}
      style={style}
      initial={initial}
      resize={resize}
    >
      <StickToBottom.Content scrollClassName={scrollClassName} className={contentClassName}>
        {children}
      </StickToBottom.Content>
    </StickToBottom>
  );
}
