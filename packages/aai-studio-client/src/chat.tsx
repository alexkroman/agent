// Copyright 2025 the AAI authors. MIT license.
// Guided chat panel (design 1b): eyebrow header, welcome bubble + starter
// prompts when empty, composer pinned at the bottom. Works before a project
// exists — the first prompt auto-creates one (via onStartWithPrompt).

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useRef, useState } from "react";
import { StickToBottom } from "use-stick-to-bottom";
import type { ChatSession, StudioStatus } from "./api.ts";
import { Markdown } from "./markdown.tsx";
import { STARTERS } from "./starters.ts";
import { ToolRow, toBlocks } from "./tool-row.tsx";

type ChatPanelProps = {
  apiKey: string;
  project: string | null;
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
  /** A project is being created for the guided-start flow. */
  creating: boolean;
  /** Prompt queued before the project existed — sent once on mount. */
  initialPrompt: string | null;
  onInitialPromptSent: () => void;
  /** No project yet: create one and forward this prompt. */
  onStartWithPrompt: (prompt: string) => void;
  /** Called after each finished assistant turn so the workspace refreshes. */
  onWorkspaceChanged: () => void;
  /** The key was rejected — same global handling as the REST queries. */
  onUnauthorized: () => void;
  /**
   * Hands the app a function that appends a message to the conversation
   * WITHOUT triggering a turn — how publish output and secret changes are
   * posted into the chat for the coding agent to see on its next turn.
   */
  registerNotify?: ((fn: ((text: string) => void) | null) => void) | undefined;
};

function MessageView({
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
          <Markdown key={block.key} text={block.text} />
        ) : (
          <ToolRow key={block.key} part={block.part} active={busy} labels={labels} />
        ),
      )}
    </div>
  );
}

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
            // isComposing: Enter confirms an IME candidate, not the message.
            if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
          }}
          disabled={disabled || busy}
          placeholder={placeholder}
        />
        <button
          type="button"
          aria-label={showStop ? "Stop" : "Send"}
          className="flex h-10 w-10 flex-none cursor-pointer items-center justify-center rounded-sm border-none bg-indigo text-white hover:bg-indigo-hover disabled:cursor-not-allowed disabled:bg-disabled disabled:text-line-strong"
          onClick={showStop ? onStop : submit}
          disabled={!showStop && (disabled || busy)}
        >
          {showStop ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6" y="6" width="12" height="12" rx="1.5" />
            </svg>
          ) : (
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden
            >
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

function EmptyStateBody({
  status,
  disabled,
  onPick,
}: {
  status: StudioStatus | undefined;
  disabled?: boolean;
  onPick: (prompt: string) => void;
}) {
  return (
    <>
      <div className="rounded-lg border border-line bg-cream px-[18px] py-4">
        <p className="m-0 text-[13px] leading-5">
          Welcome to AssemblyAI App Builder. Tell me what your voice agent should do and I'll build
          the first version.
        </p>
      </div>
      {status?.llm && (
        <div className="flex flex-col gap-2">
          <span className="text-xs text-subtle">Try one of these</span>
          {STARTERS.map((starter) => (
            <button
              type="button"
              key={starter.label}
              className="starter"
              disabled={disabled}
              onClick={() => onPick(starter.prompt)}
            >
              {starter.label}
            </button>
          ))}
        </div>
      )}
      {/* No status yet is loading or a network failure — either way, don't
          claim the server is misconfigured. */}
      {status === undefined && (
        <p className="m-0 text-xs leading-4 text-subtle">Checking the server's chat status…</p>
      )}
      {status !== undefined && !status.llm && (
        <p className="m-0 text-xs leading-4 text-subtle">
          Chat is disabled: this server has no LLM key (ASSEMBLYAI_API_KEY or ANTHROPIC_API_KEY).
          The Code view and Publish still work.
        </p>
      )}
    </>
  );
}

/**
 * The live chat, mounted only when a project exists AND its persisted
 * history has resolved — `useChat` reads `initialMessages` once at mount,
 * so hydrating later would silently drop the restored conversation.
 */
function ProjectChat({
  apiKey,
  session,
  initialMessages,
  llmStatus,
  toolLabels,
  initialPrompt,
  onInitialPromptSent,
  onWorkspaceChanged,
  onUnauthorized,
  onSessionStale,
  registerNotify,
}: Omit<
  ChatPanelProps,
  "project" | "chatHistory" | "onStartWithPrompt" | "creating" | "chatSession" | "sessionError"
> & {
  session: ChatSession;
  initialMessages: UIMessage[];
}) {
  // Keep the latest callbacks out of the transport, which is created once.
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  const staleRef = useRef(onSessionStale);
  staleRef.current = onSessionStale;

  const [transport] = useState(
    () =>
      // Turns stream DIRECTLY to the project's sandbox (the brokered URL),
      // mirroring how voice clients connect straight to a deployed agent.
      new DefaultChatTransport({
        api: session.url,
        headers: { Authorization: `Bearer ${apiKey}` },
        // A rejected key gets the same global handling as the REST queries
        // (app.tsx) — useChat only surfaces a generic Error otherwise. A 409
        // means the sandbox was replaced under us: re-broker.
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const res = await fetch(input, init);
          if (res.status === 401) unauthorizedRef.current();
          if (res.status === 409) staleRef.current();
          return res;
        }) as typeof fetch,
      }),
  );

  const { messages, sendMessage, setMessages, status, error, stop } = useChat({
    transport,
    messages: initialMessages,
    onFinish: onWorkspaceChanged,
  });

  // Publish output and secret changes arrive as injected user messages —
  // visible in the transcript, carried into the agent's next turn, and
  // persisted with the conversation when that turn settles.
  useEffect(() => {
    if (!registerNotify) return;
    registerNotify((text: string) => {
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
  }, [registerNotify, setMessages]);

  const busy = status === "submitted" || status === "streaming";
  const llmReady = llmStatus?.llm === true;

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
          {messages.length === 0 && !initialPrompt && (
            <EmptyStateBody status={llmStatus} onPick={send} />
          )}
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
      {props.project && props.sessionError && (
        <div className="flex flex-1 items-center px-6 py-5">
          <p className="m-0 text-[13px] text-err">
            Could not start the project's sandbox. Reload to try again.
          </p>
        </div>
      )}
      {props.project &&
        !props.sessionError &&
        (props.chatHistory === undefined || props.chatSession === undefined) && (
          // History or sandbox still loading: hold the panel rather than
          // flashing an empty "new chat" the restored conversation replaces.
          <div className="flex flex-1 items-center px-6 py-5">
            <p className="m-0 text-[13px] text-subtle italic">
              {props.chatHistory === undefined ? "Loading conversation…" : "Starting sandbox…"}
            </p>
          </div>
        )}
      {props.project && props.chatHistory !== undefined && props.chatSession !== undefined && (
        <ProjectChat
          apiKey={props.apiKey}
          session={props.chatSession}
          initialMessages={props.chatHistory}
          llmStatus={props.llmStatus}
          toolLabels={props.toolLabels}
          initialPrompt={props.initialPrompt}
          onInitialPromptSent={props.onInitialPromptSent}
          onWorkspaceChanged={props.onWorkspaceChanged}
          onUnauthorized={props.onUnauthorized}
          onSessionStale={props.onSessionStale}
          registerNotify={props.registerNotify}
        />
      )}
      {!props.project && (
        <>
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
            <EmptyStateBody
              status={props.llmStatus}
              // While the guided-start project is being created, a second
              // click would create a second (orphan) project.
              disabled={props.creating}
              onPick={props.onStartWithPrompt}
            />
          </div>
          <Composer
            disabled={props.creating || props.llmStatus?.llm !== true}
            placeholder={props.creating ? "Creating your project…" : "Describe your agent…"}
            onSend={props.onStartWithPrompt}
          />
        </>
      )}
    </div>
  );
}
