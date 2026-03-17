// Copyright 2025 the AAI authors. MIT license.
/**
 * Preact UI components for the voice agent interface.
 *
 * Re-exports from _components/ with explicit type annotations so JSR can
 * generate .d.ts without needing to analyze source files.
 */

import type { Signal } from "@preact/signals";
import type * as preact from "preact";
import { App as _App } from "./_components/app.tsx";
import { ChatView as _ChatView } from "./_components/chat_view.tsx";
import { ErrorBanner as _ErrorBanner } from "./_components/error_banner.tsx";
import { MessageBubble as _MessageBubble } from "./_components/message_bubble.tsx";
import { StateIndicator as _StateIndicator } from "./_components/state_indicator.tsx";
import { ThinkingIndicator as _ThinkingIndicator } from "./_components/thinking_indicator.tsx";
import { ToolCallBlock as _ToolCallBlock } from "./_components/tool_call_block.tsx";
import { Transcript as _Transcript } from "./_components/transcript.tsx";
import type { AgentState, Message, SessionError, ToolCallInfo } from "./types.ts";

/** Displays the current agent state as a colored indicator. */
export const StateIndicator: (props: { state: Signal<AgentState> }) => preact.JSX.Element =
  _StateIndicator;

/** Displays an error message banner when an error is present. */
export const ErrorBanner: (props: {
  error: Signal<SessionError | null>;
}) => preact.JSX.Element | null = _ErrorBanner;

/** Renders a single chat message bubble. */
export const MessageBubble: (props: { message: Message }) => preact.JSX.Element = _MessageBubble;

/** Renders a collapsible tool call block. */
export const ToolCallBlock: (props: { toolCall: ToolCallInfo }) => preact.JSX.Element =
  _ToolCallBlock;

/** Displays the live user utterance from STT/VAD. */
export const Transcript: (props: {
  userUtterance: Signal<string | null>;
}) => preact.JSX.Element | null = _Transcript;

/** Animated indicator shown while the agent is processing. */
export const ThinkingIndicator: () => preact.JSX.Element = _ThinkingIndicator;

/** Full chat view showing messages, transcript, and thinking state. */
export const ChatView: () => preact.JSX.Element = _ChatView;

/** Default top-level app component with start screen and chat view. */
export const App: () => preact.JSX.Element = _App;
