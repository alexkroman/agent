// Copyright 2025 the AAI authors. MIT license.
// Chat panel (design 1b): eyebrow header, welcome bubble + starter prompts
// when the project's conversation is empty, composer pinned at the bottom.
// Mounted only once a project exists — the pre-project state is the HomeHero
// (home.tsx), whose first prompt auto-creates a project.

import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ChatSession, StudioStatus } from "./api.ts";
import { errorText } from "./api-error.ts";
import { EmptyStateBody, Transcript } from "./chat-transcript.tsx";
import { Composer } from "./composer.tsx";
import { createSandboxTransport } from "./sandbox-transport.ts";
import { useMessageQueue } from "./use-message-queue.ts";

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
  /**
   * The sandbox went away mid-session — re-broker, and report the replacement
   * lease so the turn that hit the dead one can be sent again on it (see
   * sandbox-transport.ts). Also the SandboxNote's Try again button, which only
   * wants the re-broker and ignores what comes back.
   */
  onSessionStale: () => Promise<ChatSession | undefined>;
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
};

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
  const reason = errorText(error);
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="m-0 text-[13px] text-err">Could not start the project's sandbox.</p>
      {reason && <p className="m-0 text-[13px] text-subtle">{reason}</p>}
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
  onSessionStale: () => Promise<ChatSession | undefined>;
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
  // The transport is created ONCE — `useChat` owns the conversation for the
  // whole life of this component — but the lease it targets is not durable, so
  // both of these are read through refs at request time rather than captured.
  // See sandbox-transport.ts for what a stale lease costs when they are not.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const staleRef = useRef(onSessionStale);
  staleRef.current = onSessionStale;

  /** The sandbox went away mid-turn and we are waiting on its replacement. */
  const [restarting, setRestarting] = useState(false);

  const [transport] = useState(() =>
    createSandboxTransport({
      session: () => sessionRef.current,
      // Every way this surface can reject us — 401 (stale token), 409 (no
      // session), or an unreachable sandbox — means the same thing: re-broker,
      // and send the turn again on what comes back. See resilient-fetch.ts for
      // why each needs saying.
      rebroker: () => staleRef.current(),
      onRestarting: setRestarting,
    }),
  );

  const { messages, sendMessage, status, error, stop } = useChat({
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
  const queue = useMessageQueue({
    status,
    busy,
    chatReady,
    sendMessage,
    setInput: onInputChange,
  });

  // Mirror the outstanding-work state up to the app. The cleanup clears it on
  // unmount (project switch, back to home) so a turn left streaming in a
  // previous project can't keep Publish locked in the next one.
  const { pending } = queue;
  useEffect(() => {
    onBusyChange?.(pending);
    return () => onBusyChange?.(false);
  }, [pending, onBusyChange]);

  const handleStop = () => {
    queue.drainToComposer();
    // Aborts the SSE fetch; the server sees the request signal fire and
    // cancels the LLM stream, in-flight tool calls, and the session sandbox.
    // Nothing to refresh by hand afterwards: `ai@7` calls `onFinish` from a
    // `finally`, so an aborted turn reports too (with `isAbort: true`), and
    // the files it wrote before being stopped are picked up there.
    void stop();
  };

  // Prompt queued by the guided pre-project flow — send exactly once.
  const sentInitial = useRef(false);
  useEffect(() => {
    if (sentInitial.current || !initialPrompt || !chatReady) return;
    sentInitial.current = true;
    void sendMessage({ text: initialPrompt });
    onInitialPromptSent();
  }, [initialPrompt, chatReady, sendMessage, onInitialPromptSent]);

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
            {/* A re-broker mid-turn is a container boot, so saying "Working…"
                through it would report the agent as busy while nothing is
                running — the same unexplained wait SandboxNote exists to
                avoid on the way in. */}
            {restarting ? (
              <div className="text-[13px] text-subtle italic">Restarting the sandbox…</div>
            ) : (
              busy && <div className="text-[13px] text-subtle italic">Working…</div>
            )}
          </>
        }
      />
      <Composer
        disabled={!chatReady}
        busy={busy}
        onStop={handleStop}
        placeholder={busy ? "Queue a follow-up…" : "Describe your agent…"}
        value={input}
        onValueChange={onInputChange}
        onSend={queue.submit}
        queued={queue.items}
        onRemoveQueued={queue.remove}
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
  // The three states as an if/else rather than three `&&` guards over the same
  // two discriminants: written as independent tests, their mutual exclusivity
  // was something a reader had to prove, and a fourth state would render two
  // panels at once rather than fail.
  const { chatHistory, chatSession } = props;
  let body: ReactNode;
  if (chatHistory === undefined) {
    // Nothing to show yet: not even the conversation has arrived. A failed
    // broker is still worth reporting here — it is the only thing that has an
    // answer, and it comes with the button that retries it.
    body = (
      <div className="flex flex-1 flex-col items-start justify-center gap-3 px-6 py-5">
        {props.sessionError != null ? (
          <SandboxNote error={props.sessionError} onRetry={props.onSessionStale} />
        ) : (
          <p className="m-0 text-[13px] text-subtle italic">Loading conversation…</p>
        )}
      </div>
    );
  } else if (chatSession === undefined) {
    body = (
      <PendingChat
        history={chatHistory}
        chatStatus={props.chatStatus}
        toolLabels={props.toolLabels}
        initialPrompt={props.initialPrompt}
        sessionError={props.sessionError}
        onSessionStale={props.onSessionStale}
        input={input}
        onInputChange={setInput}
      />
    );
  } else {
    body = (
      <ProjectChat
        session={chatSession}
        initialMessages={chatHistory}
        chatStatus={props.chatStatus}
        toolLabels={props.toolLabels}
        initialPrompt={props.initialPrompt}
        onInitialPromptSent={props.onInitialPromptSent}
        onWorkspaceChanged={props.onWorkspaceChanged}
        onBusyChange={props.onBusyChange}
        onSessionStale={props.onSessionStale}
        input={input}
        onInputChange={setInput}
      />
    );
  }
  return (
    <div className="flex w-[360px] flex-none flex-col border-r border-line bg-panel">
      <div className="flex items-center justify-between gap-2 px-6 pt-5">
        <span className="eyebrow">Agent</span>
      </div>
      {body}
    </div>
  );
}
