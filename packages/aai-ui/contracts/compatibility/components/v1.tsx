// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:components` epoch 1.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * A custom chrome assembled from the design system — the shape a
 * `client({ component })` renders, where the built-in shell is replaced but its
 * parts are reused.
 */

import {
  AutoScroll,
  Button,
  type ButtonSize,
  type ButtonVariant,
  ChatView,
  Controls,
  Markdown,
  type MarkdownVariant,
  MessageList,
  SidebarLayout,
  StartScreen,
  ToolCallRow,
  type ToolCallRowProps,
  type ToolCallRowVariant,
} from "../../../index.ts";

const variant: ButtonVariant = "secondary";
const size: ButtonSize = "lg";
const markdown: MarkdownVariant = "compact";
const rowVariant: ToolCallRowVariant = "compact";

/** A tool row rendered from props the client builds itself. */
export function Row(props: ToolCallRowProps) {
  return <ToolCallRow {...props} />;
}

export function Chrome() {
  return (
    <SidebarLayout
      sidebar={<aside>Orders</aside>}
      sidebarWidth="20rem"
      sidebarPosition="right"
      className="h-full"
    >
      <StartScreen
        title="Support"
        subtitle="Talk to an agent."
        buttonText="Start"
        icon={<span>🎙️</span>}
      >
        {/* The bounded height is the one constraint AutoScroll's callers get wrong. */}
        <AutoScroll className="flex-1 min-h-0" initial="instant" resize="smooth">
          <MessageList className="p-4" />
          <Markdown text="**Ready.**" variant={markdown} />
          <ToolCallRow title="Looking up your order" pending variant={rowVariant} />
        </AutoScroll>
        <Controls className="border-t" />
        <Button variant={variant} size={size} onClick={() => undefined}>
          Hang up
        </Button>
      </StartScreen>
    </SidebarLayout>
  );
}

/** The built-in chat surface, for a client that only wants its own title. */
export function Default() {
  return <ChatView title="Support" icon={<span>🎧</span>} className="h-full" />;
}
