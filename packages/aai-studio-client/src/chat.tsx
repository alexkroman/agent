// Copyright 2025 the AAI authors. MIT license.
// Chat panel (design 1b): eyebrow header, welcome bubble + starter prompts
// when the project's conversation is empty, composer pinned at the bottom.
// Mounted only once a project exists — the pre-project state is the HomeHero
// (home.tsx), whose first prompt auto-creates a project.

import { useChat } from "@ai-sdk/react";
import { Markdown } from "@alexkroman1/aai-ui";
import { DefaultChatTransport, type UIMessage } from "ai";
import clsx from "clsx";
import { memo, useEffect, useRef, useState } from "react";
import { StickToBottom } from "use-stick-to-bottom";
import type { ChatSession, StudioStatus } from "./api.ts";
import { LlmStatusNote } from "./llm-status-note.tsx";
import { createResilientFetch } from "./resilient-fetch.ts";
import { isEnterSubmit, SEND_BUTTON_CLASS, SendIcon, StopIcon } from "./send-button.tsx";
import { ToolRow, toBlocks } from "./tool-row.tsx";

type ChatPanelProps = {
  /**
   * The project's persisted conversation, restored on open. `undefined`
   * while the fetch is in flight — the panel shows a loading state instead
   * of flashing an empty "new chat" composer that hydration then replaces.
   */
  chatHistory: UIMessage[] | undefined;
  /** Undefined while `/studio/status` is loading or unreachable. */
  llmStatus: StudioStatus | undefined;
  /** The project's brokered sandbox; undefined while booting. */
  chatSession: ChatSession | undefined;
  /** Booting the sandbox failed — show a retryable error state. */
  sessionError?: boolean;
  /** Tool name → friendly label, served by the sandbox. */
  toolLabels?: Record<string, string> | undefined;
  /** The sandbox went away mid-session — re-broker. */
  onSessionStale: () => void;
  /** Prompt queued before the project existed — sent once on mount. */
  initialPrompt: string | null;
  onInitialPromptSent: () => void;
  /** Called after each finished assistant turn so the workspace refreshes. */
  onWorkspaceChanged: () => void;
  /**
   * Reports whether a turn is in flight. The app gates Publish on this: the
   * preview only deploys on the END-OF-TURN workspace sync (mid-turn
   * checkpoints never do — a half-finished tree must not ship), and Publish
   * deploys the same workspace, so it must wait for the same event.
   */
  onBusyChange?: ((busy: boolean) => void) | undefined;
  /**
   * Hands the app a function that posts a message into the conversation —
   * how publish output and secret changes reach the coding agent. See
   * {@link NotifyChat} for the two modes.
   */
  registerNotify?: ((fn: NotifyChat | null) => void) | undefined;
};

/**
 * Post a message into the live conversation.
 *
 * Default is a silent append: the message shows in the transcript and rides
 * along with the agent's *next* turn, which is what a successful publish or a
 * secret change wants — neither needs an answer, and spending a turn on
 * "published fine" invites the agent to go do unrequested work.
 *
 * `respond: true` sends it as a real turn instead. A FAILED publish needs
 * that: the CLI output is only useful if the agent actually engages with it,
 * and as a silent note it would sit there until the user typed something,
 * which reads as the agent ignoring a build break it was told about.
 */
export type NotifyChat = (text: string, opts?: { respond?: boolean }) => void;

/**
 * How a notification should reach the conversation.
 *
 * Falls back to `"append"` rather than dropping when a turn is already in
 * flight or the LLM isn't up: a publish failure has to survive either way,
 * and the next turn still carries an appended message.
 */
export function notifyDispatch(
  opts: { respond?: boolean } | undefined,
  state: { busy: boolean; llmReady: boolean },
): "turn" | "append" {
  return opts?.respond === true && !state.busy && state.llmReady ? "turn" : "append";
}

// Memoized: while a turn streams, useChat updates dozens of times a second
// but only the streaming message's identity changes — settled messages must
// not re-run their markdown parse on every chunk.
const MessageView = memo(function MessageView({
  message,
  busy = false,
  labels,
}: {
  message: UIMessage;
  busy?: boolean;
  labels?: Record<string, string> | undefined;
}) {
  if (message.role === "user") {
    const text = message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg border border-line bg-cream px-3.5 py-2 text-[13px] leading-5 break-words whitespace-pre-wrap">
          {text}
        </div>
      </div>
    );
  }
  return (
    <div className="text-[13px] leading-[19px] break-words">
      {toBlocks(message).map((block) =>
        block.kind === "text" ? (
          <Markdown key={block.key} text={block.text} variant="compact" />
        ) : (
          <ToolRow key={block.key} part={block.part} active={busy} labels={labels} />
        ),
      )}
    </div>
  );
});

type ComposerProps = {
  disabled: boolean;
  placeholder: string;
  onSend: (text: string) => void;
  /** A turn is in flight: the send button becomes a Stop button. */
  busy?: boolean;
  /** Cancel the in-flight turn. Required whenever `busy` can be true. */
  onStop?: () => void;
};

/**
 * Composer pinned to the panel bottom (1b spec). Exported for tests.
 * While a turn streams, the send button swaps to a Stop button — the one
 * escape hatch when a tool call is taking forever.
 */
export function Composer({ disabled, placeholder, onSend, busy = false, onStop }: ComposerProps) {
  const [input, setInput] = useState("");
  const submit = () => {
    const text = input.trim();
    if (!text || disabled || busy) return;
    setInput("");
    onSend(text);
  };
  const showStop = busy && onStop != null;
  return (
    <div className="flex flex-none flex-col gap-2 border-t border-line px-5 pt-4 pb-5">
      <div className="flex items-center gap-2">
        <input
          className="field h-10 min-w-0 flex-1 border-line-strong"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (isEnterSubmit(e)) submit();
          }}
          disabled={disabled || busy}
          placeholder={placeholder}
        />
        <button
          type="button"
          aria-label={showStop ? "Stop" : "Send"}
          className={clsx("h-10 w-10", SEND_BUTTON_CLASS)}
          onClick={showStop ? onStop : submit}
          disabled={!showStop && (disabled || busy)}
        >
          {showStop ? <StopIcon /> : <SendIcon />}
        </button>
      </div>
    </div>
  );
}

function EmptyStateBody({ status }: { status: StudioStatus | undefined }) {
  return (
    <>
      <div className="rounded-lg border border-line bg-cream px-[18px] py-4">
        <p className="m-0 text-[13px] leading-5">
          Welcome to AssemblyAI App Builder. Tell me what your voice agent should do and I'll build
          the first version.
        </p>
      </div>
      <LlmStatusNote status={status} />
    </>
  );
}

/**
 * The live chat, mounted only when a project exists AND its persisted
 * history has resolved — `useChat` reads `initialMessages` once at mount,
 * so hydrating later would silently drop the restored conversation.
 */
function ProjectChat({
  session,
  initialMessages,
  llmStatus,
  toolLabels,
  initialPrompt,
  onInitialPromptSent,
  onWorkspaceChanged,
  onBusyChange,
  onSessionStale,
  registerNotify,
}: Omit<ChatPanelProps, "chatHistory" | "chatSession" | "sessionError"> & {
  session: ChatSession;
  initialMessages: UIMessage[];
}) {
  // Keep the latest callbacks out of the transport, which is created once.
  const staleRef = useRef(onSessionStale);
  staleRef.current = onSessionStale;

  const [transport] = useState(
    () =>
      // Turns stream DIRECTLY to the project's sandbox (the brokered URL),
      // mirroring how voice clients connect straight to a deployed agent.
      new DefaultChatTransport({
        api: session.url,
        // The broker-minted per-session token — the browser never holds a
        // long-lived credential for the sandbox's public surface.
        headers: { Authorization: `Bearer ${session.token}` },
        // Every way this surface can reject us — 401 (stale token), 409
        // (no session), or an unreachable sandbox — means the same thing:
        // re-broker. See resilient-fetch.ts for why each needs saying.
        fetch: createResilientFetch({ onStale: () => staleRef.current() }),
      }),
  );

  const { messages, sendMessage, setMessages, status, error, stop } = useChat({
    transport,
    messages: initialMessages,
    onFinish: onWorkspaceChanged,
  });

  const busy = status === "submitted" || status === "streaming";
  const llmReady = llmStatus?.llm === true;

  // Mirror the in-flight state up to the app. The cleanup clears it on
  // unmount (project switch, back to home) so a turn left streaming in a
  // previous project can't keep Publish locked in the next one.
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  // Read through refs so the registration below stays stable: re-registering
  // on every status tick would swap the function the app holds mid-publish.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const llmReadyRef = useRef(llmReady);
  llmReadyRef.current = llmReady;

  // Publish output and secret changes arrive as injected user messages —
  // visible in the transcript, carried into the agent's next turn, and
  // persisted with the conversation when that turn settles.
  useEffect(() => {
    if (!registerNotify) return;
    registerNotify((text, opts) => {
      const mode = notifyDispatch(opts, {
        busy: busyRef.current,
        llmReady: llmReadyRef.current,
      });
      if (mode === "turn") {
        void sendMessage({ text });
        return;
      }
      setMessages((current) => [
        ...current,
        {
          id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "user",
          parts: [{ type: "text", text }],
        },
      ]);
    });
    return () => registerNotify(null);
  }, [registerNotify, setMessages, sendMessage]);

  const handleStop = () => {
    // Aborts the SSE fetch; the server sees the request signal fire and
    // cancels the LLM stream, in-flight tool calls, and the session sandbox.
    void stop();
    // The turn may have written files before it was stopped — onFinish won't
    // fire for an aborted stream, so refresh the workspace here.
    onWorkspaceChanged();
  };

  // Prompt queued by the guided pre-project flow — send exactly once.
  const sentInitial = useRef(false);
  useEffect(() => {
    if (sentInitial.current || !initialPrompt || !llmReady) return;
    sentInitial.current = true;
    void sendMessage({ text: initialPrompt });
    onInitialPromptSent();
  }, [initialPrompt, llmReady, sendMessage, onInitialPromptSent]);

  const send = (text: string) => {
    if (busy || !llmReady) return;
    void sendMessage({ text });
  };

  return (
    <>
      {/* StickToBottom follows streamed output but releases when the user
          scrolls up to read, re-engaging once they return to the bottom. */}
      <StickToBottom className="min-h-0 flex-1" initial="instant" resize="smooth">
        <StickToBottom.Content className="flex flex-col gap-4 px-6 py-5">
          {messages.length === 0 && !initialPrompt && <EmptyStateBody status={llmStatus} />}
          {messages.map((message) => (
            <MessageView key={message.id} message={message} busy={busy} labels={toolLabels} />
          ))}
          {error && <div className="text-[13px] text-err">{error.message}</div>}
          {busy && <div className="text-[13px] text-subtle italic">Working…</div>}
        </StickToBottom.Content>
      </StickToBottom>
      <Composer
        disabled={!llmReady}
        busy={busy}
        onStop={handleStop}
        placeholder="Describe your agent…"
        onSend={send}
      />
    </>
  );
}

export function ChatPanel(props: ChatPanelProps) {
  return (
    <div className="flex w-[360px] flex-none flex-col border-r border-line bg-panel">
      <div className="flex items-center justify-between gap-2 px-6 pt-5">
        <span className="eyebrow">Agent</span>
      </div>
      {props.sessionError && (
        <div className="flex flex-1 flex-col items-start justify-center gap-3 px-6 py-5">
          <p className="m-0 text-[13px] text-err">Could not start the project's sandbox.</p>
          {/* Re-broker in place — the retries behind "Starting sandbox…"
              already gave up, so recovery must not require a page reload. */}
          <button type="button" className="btn" onClick={props.onSessionStale}>
            Try again
          </button>
        </div>
      )}
      {!props.sessionError &&
        (props.chatHistory === undefined || props.chatSession === undefined) && (
          // History or sandbox still loading: hold the panel rather than
          // flashing an empty "new chat" the restored conversation replaces.
          <div className="flex flex-1 items-center px-6 py-5">
            <p className="m-0 text-[13px] text-subtle italic">
              {props.chatHistory === undefined ? "Loading conversation…" : "Starting sandbox…"}
            </p>
          </div>
        )}
      {props.chatHistory !== undefined && props.chatSession !== undefined && (
        <ProjectChat
          session={props.chatSession}
          initialMessages={props.chatHistory}
          llmStatus={props.llmStatus}
          toolLabels={props.toolLabels}
          initialPrompt={props.initialPrompt}
          onInitialPromptSent={props.onInitialPromptSent}
          onWorkspaceChanged={props.onWorkspaceChanged}
          onBusyChange={props.onBusyChange}
          onSessionStale={props.onSessionStale}
          registerNotify={props.registerNotify}
        />
      )}
    </div>
  );
}
