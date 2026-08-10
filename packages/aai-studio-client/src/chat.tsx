// Copyright 2025 the AAI authors. MIT license.
// Chat panel (design 1b): eyebrow header, welcome bubble + starter prompts
// when the project's conversation is empty, composer pinned at the bottom.
// Mounted only once a project exists — the pre-project state is the HomeHero
// (home.tsx), whose first prompt auto-creates a project.

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ChatSession, StudioStatus } from "./api.ts";
import { errorText } from "./api-error.ts";
import { drainText, EMPTY_QUEUE, hasPendingWork, nextToFlush, queueReducer } from "./chat-queue.ts";
import { EmptyStateBody, Transcript } from "./chat-transcript.tsx";
import { Composer } from "./composer.tsx";
import { createResilientFetch } from "./resilient-fetch.ts";

type ChatPanelProps = {
  /**
   * The project's persisted conversation, restored on open. `undefined`
   * while the fetch is in flight — the panel shows a loading state instead
   * of flashing an empty "new chat" composer that hydration then replaces.
   *
   * It is rendered as soon as it lands, WITHOUT waiting for the sandbox: the
   * two requests go out together but the broker has to boot a container, so
   * gating the transcript on it left a project the user just clicked showing
   * nothing it already knew for seconds. What waits on the sandbox is
   * SENDING, which is what actually needs it.
   */
  chatHistory: UIMessage[] | undefined;
  /** Undefined while `/studio/status` is loading or unreachable. */
  chatStatus: StudioStatus | undefined;
  /** The project's brokered sandbox; undefined while booting. */
  chatSession: ChatSession | undefined;
  /**
   * The error that ended the broker's retries, or null/undefined while the
   * session is loading or live. The ERROR itself rather than a boolean: the
   * platform answers a sandbox that would not start with a 503 whose body
   * says which way it failed, and that sentence is the only thing that tells
   * a user whether to press "Try again" now or come back later.
   */
  sessionError?: unknown;
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
   * Reports whether the agent still has work to do — a turn in flight OR
   * queued follow-ups waiting behind it. The app gates Publish on this: the
   * preview only deploys on the END-OF-TURN workspace sync (mid-turn
   * checkpoints never do — a half-finished tree must not ship), and Publish
   * deploys the same workspace, so it must wait for the same event. Queued
   * messages count because the gap between two queued turns is a moment when
   * no turn is in flight and the tree is still mid-edit.
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
 * flight or chat is not yet accepting: a publish failure has to survive
 * either way, and the next turn still carries an appended message.
 */
export function notifyDispatch(
  opts: { respond?: boolean } | undefined,
  state: { busy: boolean; chatReady: boolean },
): "turn" | "append" {
  return opts?.respond === true && !state.busy && state.chatReady ? "turn" : "append";
}

/**
 * What the brokered sandbox is doing, rendered at the foot of the restored
 * transcript — the thing the composer is waiting on, said where the next
 * message would appear rather than in place of the conversation.
 *
 * The failure keeps the history up for the same reason the wait does: the
 * transcript is readable without a sandbox, and replacing it with an error
 * card threw away the one thing that had already loaded. The server's own
 * reason rides along when it gave one — a capacity or boot timeout reads very
 * differently from a bad key, and the generic line cannot tell them apart.
 */
function SandboxNote({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error == null) {
    return <p className="m-0 text-[13px] text-subtle italic">Starting sandbox…</p>;
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="m-0 text-[13px] text-err">Could not start the project's sandbox.</p>
      {errorText(error) && <p className="m-0 text-[13px] text-subtle">{errorText(error)}</p>}
      {/* Re-broker in place — the retries behind "Starting sandbox…" already
          gave up, so recovery must not require a page reload. */}
      <button type="button" className="btn" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/**
 * The project's conversation before its sandbox exists: the restored history,
 * read-only, with {@link SandboxNote} where the next turn will go.
 *
 * The composer is present and TYPABLE, only unable to send. A brokered
 * sandbox takes seconds, and a dead field for those seconds is the same
 * swallow-what-you-typed bug the follow-up queue exists to fix — one step
 * earlier. The text lives in ChatPanel, so it is still there (and sendable)
 * the moment the live chat takes over.
 */
function PendingChat({
  history,
  chatStatus,
  toolLabels,
  initialPrompt,
  sessionError,
  onSessionStale,
  input,
  onInputChange,
}: {
  history: UIMessage[];
  chatStatus: StudioStatus | undefined;
  toolLabels?: Record<string, string> | undefined;
  initialPrompt: string | null;
  sessionError: unknown;
  onSessionStale: () => void;
  input: string;
  onInputChange: Dispatch<SetStateAction<string>>;
}) {
  return (
    <>
      <Transcript
        messages={history}
        labels={toolLabels}
        lead={
          history.length === 0 && !initialPrompt ? <EmptyStateBody status={chatStatus} /> : null
        }
        footer={<SandboxNote error={sessionError} onRetry={onSessionStale} />}
      />
      <Composer
        disabled={false}
        sendDisabled
        placeholder={
          sessionError != null ? "Sandbox unavailable…" : "Starting sandbox — write ahead…"
        }
        value={input}
        onValueChange={onInputChange}
        // Unreachable: `sendDisabled` returns before any send.
        onSend={() => undefined}
      />
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
  chatStatus,
  toolLabels,
  initialPrompt,
  onInitialPromptSent,
  onWorkspaceChanged,
  onBusyChange,
  onSessionStale,
  registerNotify,
  input,
  onInputChange,
}: Omit<ChatPanelProps, "chatHistory" | "chatSession" | "sessionError"> & {
  session: ChatSession;
  initialMessages: UIMessage[];
  /**
   * The composer's text, owned by ChatPanel so that anything written while
   * the sandbox was still starting survives this component mounting under it.
   * A `SetStateAction` rather than a plain setter because a Stop drains the
   * queue into whatever is already there.
   */
  input: string;
  onInputChange: Dispatch<SetStateAction<string>>;
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
  // Chat itself is unconditional — it runs on the caller's own key — so this
  // is only "has `/studio/status` answered yet".
  const chatReady = chatStatus !== undefined;

  // Follow-ups typed while the agent works. The composer's text lives one
  // level up (see `input`), so a Stop can hand the queue back to it.
  const [queue, dispatchQueue] = useReducer(queueReducer, EMPTY_QUEUE);
  const setInput = onInputChange;
  const pending = hasPendingWork(queue, busy);

  /**
   * Hand the queue back to the composer: the one answer to "this turn will not
   * end normally". Used by an explicit Stop and by a failed turn — neither may
   * fire the follow-ups (a Stop is the user taking control back, and a
   * follow-up sent over a failed turn buries the error), and neither may eat
   * text the user typed while waiting.
   */
  const drainQueueToComposer = useCallback(() => {
    if (queue.items.length === 0) return;
    setInput((current) => drainText(queue, current));
    dispatchQueue({ type: "clear" });
  }, [queue, setInput]);

  // Send the head of the queue the moment a turn settles — one turn at a
  // time, FIFO. While a turn runs, `turn-observed` releases the dispatch
  // latch (see chat-queue.ts for why it exists at all).
  useEffect(() => {
    if (busy) {
      dispatchQueue({ type: "turn-observed" });
      return;
    }
    // A failed turn parks the queue, and `status` stays `error` until some
    // request starts — but every submit joins the queue while it is non-empty,
    // so parking it here would wedge the composer permanently.
    if (status === "error") {
      drainQueueToComposer();
      return;
    }
    const next = nextToFlush(queue, { status, chatReady });
    if (next === null) return;
    dispatchQueue({ type: "dispatch" });
    void sendMessage({ text: next });
  }, [busy, status, chatReady, queue, sendMessage, drainQueueToComposer]);

  // Mirror the outstanding-work state up to the app. The cleanup clears it on
  // unmount (project switch, back to home) so a turn left streaming in a
  // previous project can't keep Publish locked in the next one.
  useEffect(() => {
    onBusyChange?.(pending);
    return () => onBusyChange?.(false);
  }, [pending, onBusyChange]);

  // Read through refs so the registration below stays stable: re-registering
  // on every status tick would swap the function the app holds mid-publish.
  // `pending`, not `busy`: a note sent as its own turn while follow-ups are
  // queued would jump the line, so it appends instead.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const chatReadyRef = useRef(chatReady);
  chatReadyRef.current = chatReady;

  // Publish output and secret changes arrive as injected user messages —
  // visible in the transcript, carried into the agent's next turn, and
  // persisted with the conversation when that turn settles.
  useEffect(() => {
    if (!registerNotify) return;
    registerNotify((text, opts) => {
      const mode = notifyDispatch(opts, {
        busy: pendingRef.current,
        chatReady: chatReadyRef.current,
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
    drainQueueToComposer();
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
    if (sentInitial.current || !initialPrompt || !chatReady) return;
    sentInitial.current = true;
    void sendMessage({ text: initialPrompt });
    onInitialPromptSent();
  }, [initialPrompt, chatReady, sendMessage, onInitialPromptSent]);

  const send = (text: string) => {
    if (!chatReady) return;
    if (pending) {
      dispatchQueue({ type: "queue", text });
      return;
    }
    void sendMessage({ text });
  };

  return (
    <>
      <Transcript
        messages={messages}
        busy={busy}
        labels={toolLabels}
        lead={
          messages.length === 0 && !initialPrompt ? <EmptyStateBody status={chatStatus} /> : null
        }
        footer={
          <>
            {error && <div className="text-[13px] text-err">{error.message}</div>}
            {busy && <div className="text-[13px] text-subtle italic">Working…</div>}
          </>
        }
      />
      <Composer
        disabled={!chatReady}
        busy={busy}
        onStop={handleStop}
        placeholder={busy ? "Queue a follow-up…" : "Describe your agent…"}
        value={input}
        onValueChange={setInput}
        onSend={send}
        queued={queue.items}
        onRemoveQueued={(id) => dispatchQueue({ type: "remove", id })}
      />
    </>
  );
}

/**
 * The chat panel, in three states — and the ORDER of the two waits is the
 * point. The history and the sandbox are requested together when a project
 * opens, but the history is a row read and the sandbox is a container boot, so
 * the transcript lands first and is shown first; only the ability to SEND
 * waits on the broker, said in a note under the last message.
 *
 * The composer's text is owned here rather than by ProjectChat because that
 * component mounts LATE — when the sandbox arrives — and anything typed
 * against the pre-sandbox composer would be thrown away by the swap.
 */
export function ChatPanel(props: ChatPanelProps) {
  const [input, setInput] = useState("");
  return (
    <div className="flex w-[360px] flex-none flex-col border-r border-line bg-panel">
      <div className="flex items-center justify-between gap-2 px-6 pt-5">
        <span className="eyebrow">Agent</span>
      </div>
      {props.chatHistory === undefined && (
        // Nothing to show yet: not even the conversation has arrived. A failed
        // broker is still worth reporting here — it is the only thing that has
        // an answer, and it comes with the button that retries it.
        <div className="flex flex-1 flex-col items-start justify-center gap-3 px-6 py-5">
          {props.sessionError != null ? (
            <SandboxNote error={props.sessionError} onRetry={props.onSessionStale} />
          ) : (
            <p className="m-0 text-[13px] text-subtle italic">Loading conversation…</p>
          )}
        </div>
      )}
      {props.chatHistory !== undefined && props.chatSession === undefined && (
        <PendingChat
          history={props.chatHistory}
          chatStatus={props.chatStatus}
          toolLabels={props.toolLabels}
          initialPrompt={props.initialPrompt}
          sessionError={props.sessionError}
          onSessionStale={props.onSessionStale}
          input={input}
          onInputChange={setInput}
        />
      )}
      {props.chatHistory !== undefined && props.chatSession !== undefined && (
        <ProjectChat
          session={props.chatSession}
          initialMessages={props.chatHistory}
          chatStatus={props.chatStatus}
          toolLabels={props.toolLabels}
          initialPrompt={props.initialPrompt}
          onInitialPromptSent={props.onInitialPromptSent}
          onWorkspaceChanged={props.onWorkspaceChanged}
          onBusyChange={props.onBusyChange}
          onSessionStale={props.onSessionStale}
          registerNotify={props.registerNotify}
          input={input}
          onInputChange={setInput}
        />
      )}
    </div>
  );
}
