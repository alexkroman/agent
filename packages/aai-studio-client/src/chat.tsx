// Copyright 2025 the AAI authors. MIT license.
// Guided chat panel (design 1b): eyebrow header, welcome bubble + starter
// prompts when empty, composer pinned at the bottom. Works before a project
// exists — the first prompt auto-creates one (via onStartWithPrompt).

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { StickToBottom } from "use-stick-to-bottom";
import type { StudioStatus } from "./api.ts";
import { Markdown } from "./markdown.tsx";
import { STARTERS } from "./starters.ts";

type ChatPanelProps = {
  apiKey: string;
  project: string | null;
  /** Undefined while `/studio/status` is loading or unreachable. */
  llmStatus: StudioStatus | undefined;
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
};

function toolPartName(part: { type: string; toolName?: string }): string {
  if (part.type === "dynamic-tool") return part.toolName ?? "tool";
  return part.type.replace(/^tool-/, "");
}

function isToolPart(part: { type: string }): boolean {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

/**
 * One tool invocation, rendered as the same console row the deployed agent UI
 * uses (`aai-ui`'s ToolCallBlock): outlined TOOL chip, tool name in mono, a
 * truncated args preview, and a chevron that rotates to expand the result.
 * The two surfaces show the same thing, so they should read as one component —
 * only the type scale differs, since the studio is a denser surface.
 */
export function ToolRow({
  part,
  active = true,
}: {
  part: Record<string, unknown> & { type: string };
  /** False once the turn is over — a call abandoned by Stop must not shimmer forever. */
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const name = toolPartName(part as { type: string; toolName?: string });
  const done = part.state === "output-available";
  const output = part.output;
  const args = part.input == null ? "" : JSON.stringify(part.input);
  const canExpand = part.input != null || (done && output != null);

  return (
    <div className="my-1 overflow-hidden rounded-md border border-line bg-cream">
      <button
        type="button"
        aria-expanded={canExpand ? open : undefined}
        disabled={!canExpand}
        className={clsx(
          "flex w-full appearance-none items-center gap-2 border-none bg-transparent px-3 py-2 text-left select-none",
          canExpand && "cursor-pointer",
        )}
        onClick={() => canExpand && setOpen((v) => !v)}
      >
        <span className="shrink-0 rounded-sm border border-line px-1.5 py-[3px] text-[9px] leading-none font-medium tracking-[1.2px] text-subtle uppercase">
          Tool
        </span>
        <span
          className={clsx(
            "shrink-0 font-mono text-[11px] font-medium text-fg",
            !done && active && "tool-shimmer",
          )}
        >
          {name}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-subtle">{args}</span>
        {canExpand && (
          <span
            className={clsx(
              "shrink-0 text-[9px] text-subtle transition-transform duration-150",
              open && "rotate-90",
            )}
          >
            ▶
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-line bg-panel px-3 py-2 text-subtle">
          {part.input != null && (
            <code className="block overflow-x-auto font-mono text-[10px] break-all whitespace-pre-wrap">
              {JSON.stringify(part.input).slice(0, 300)}
            </code>
          )}
          {done && output != null && (
            <pre className="m-0 mt-1 block overflow-x-auto font-mono text-[10px] break-all whitespace-pre-wrap">
              {(typeof output === "string" ? output : JSON.stringify(output)).slice(0, 600)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

type MessageBlock =
  | { key: string; kind: "text"; text: string }
  | { key: string; kind: "tool"; part: Record<string, unknown> & { type: string } };

/**
 * Group a message's parts into renderable blocks with stable keys: tool
 * blocks key on their toolCallId, text runs key on the tool block they
 * follow (parts are append-only, so these never collide or reorder).
 * Exported for tests.
 */
export function toBlocks(message: UIMessage): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let lastToolKey = "lead";
  for (const part of message.parts) {
    if (part.type === "text") {
      const last = blocks.at(-1);
      if (last?.kind === "text") {
        last.text += part.text;
      } else {
        blocks.push({ key: `text-${lastToolKey}`, kind: "text", text: part.text });
      }
    } else if (isToolPart(part)) {
      const raw = part as Record<string, unknown> & { type: string };
      lastToolKey = String(raw.toolCallId ?? `tool-${blocks.length}`);
      blocks.push({ key: lastToolKey, kind: "tool", part: raw });
    }
  }
  return blocks;
}

function MessageView({ message, busy = false }: { message: UIMessage; busy?: boolean }) {
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
          <ToolRow key={block.key} part={block.part} active={busy} />
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
          Welcome to AssemblyAI App Builder. Tell me what your voice agent or workflow should do and
          I'll build the first version.
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

/** The live chat, mounted only when a project exists. */
function ProjectChat({
  apiKey,
  project,
  llmStatus,
  initialPrompt,
  onInitialPromptSent,
  onWorkspaceChanged,
  onUnauthorized,
}: Omit<ChatPanelProps, "project" | "onStartWithPrompt" | "creating"> & {
  project: string;
}) {
  // Keep the latest callback out of the transport, which is created once.
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  const [transport] = useState(
    () =>
      new DefaultChatTransport({
        api: "/studio/chat",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: () => ({ project }),
        // A rejected key gets the same global handling as the REST queries
        // (app.tsx) — useChat only surfaces a generic Error otherwise.
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const res = await fetch(input, init);
          if (res.status === 401) unauthorizedRef.current();
          return res;
        }) as typeof fetch,
      }),
  );

  const { messages, sendMessage, status, error, stop } = useChat({
    transport,
    onFinish: onWorkspaceChanged,
  });

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
            <MessageView key={message.id} message={message} busy={busy} />
          ))}
          {error && <div className="text-[13px] text-err">{error.message}</div>}
          {busy && <div className="text-[13px] text-subtle italic">Working…</div>}
        </StickToBottom.Content>
      </StickToBottom>
      <Composer
        disabled={!llmReady}
        busy={busy}
        onStop={handleStop}
        placeholder="Describe your agent or workflow…"
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
      {props.project ? (
        <ProjectChat
          apiKey={props.apiKey}
          project={props.project}
          llmStatus={props.llmStatus}
          initialPrompt={props.initialPrompt}
          onInitialPromptSent={props.onInitialPromptSent}
          onWorkspaceChanged={props.onWorkspaceChanged}
          onUnauthorized={props.onUnauthorized}
        />
      ) : (
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
            placeholder={
              props.creating ? "Creating your project…" : "Describe your agent or workflow…"
            }
            onSend={props.onStartWithPrompt}
          />
        </>
      )}
    </div>
  );
}
