// Copyright 2025 the AAI authors. MIT license.
// Guided chat panel (design 1b): eyebrow header, welcome bubble + starter
// prompts when empty, composer pinned at the bottom. Works before a project
// exists — the first prompt auto-creates one (via onStartWithPrompt).

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { StickToBottom } from "use-stick-to-bottom";
import { Markdown } from "./markdown.tsx";

export type LlmStatus = { llm: boolean; provider?: string; model?: string };

type ChatPanelProps = {
  apiKey: string;
  project: string | null;
  llmStatus: LlmStatus;
  /** Prompt queued before the project existed — sent once on mount. */
  initialPrompt: string | null;
  onInitialPromptSent: () => void;
  /** No project yet: create one and forward this prompt. */
  onStartWithPrompt: (prompt: string) => void;
  /** Called after each finished assistant turn so the workspace refreshes. */
  onWorkspaceChanged: () => void;
};

/**
 * Starter prompts. `label` is the button; `prompt` is what the agent receives
 * — several of these need to name providers and model ids precisely, which is
 * far too much text to put on a button.
 */
const STARTERS: { label: string; prompt: string }[] = [
  {
    label: "Cascaded agent with Assembly STT, Assembly TTS, Gemini Flash Lite",
    // "Cascaded" is the user-facing name for pipeline mode. Spelled out so the
    // agent writes a pipeline config rather than defaulting to S2S. STT, LLM,
    // and TTS all bill to ASSEMBLYAI_API_KEY, which publishing seeds — so this
    // path needs no secrets from the user.
    prompt:
      "Build a cascaded (pipeline-mode) agent: " +
      'stt: assemblyAI({ model: "universal-3-5-pro" }) from "@alexkroman1/aai/stt", ' +
      'llm: the AssemblyAI LLM Gateway with model "gemini-2.5-flash-lite" ' +
      'from "@alexkroman1/aai/llm", and tts: assemblyAI({ voice: "vera" }) from ' +
      '"@alexkroman1/aai/tts". The factory is called assemblyAI in all three ' +
      "subpaths, so alias two of them on import. Make it a friendly " +
      "general-purpose voice assistant, then run test_agent.",
  },
  {
    label: "A drive-thru agent that takes food orders",
    prompt: "A drive-thru agent that takes food orders",
  },
  {
    label: "A front-desk agent that books appointments",
    prompt: "A front-desk agent that books appointments",
  },
  {
    label: "A support agent that triages inbound calls",
    prompt: "A support agent that triages inbound calls",
  },
  {
    label: "A one-shot dictation transform (no TTS)",
    prompt:
      "A one-shot speech-to-text transform (text-only, tts: none()): I speak or " +
      "upload a short audio file and get back structured notes as text — not a " +
      "chat. An LLM transform turns each dictation independently into clean " +
      "notes (output only the notes), and JavaScript tools compute word counts " +
      "and extract action items",
  },
];

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
export function ToolRow({ part }: { part: Record<string, unknown> & { type: string } }) {
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
            !done && "tool-shimmer",
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
 */
function toBlocks(message: UIMessage): MessageBlock[] {
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

function MessageView({ message }: { message: UIMessage }) {
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
          <ToolRow key={block.key} part={block.part} />
        ),
      )}
    </div>
  );
}

type ComposerProps = {
  disabled: boolean;
  placeholder: string;
  onSend: (text: string) => void;
  /** Rendered above the input row (e.g. the model picker). */
};

/** Composer pinned to the panel bottom (1b spec). */
function Composer({ disabled, placeholder, onSend }: ComposerProps) {
  const [input, setInput] = useState("");
  const submit = () => {
    const text = input.trim();
    if (!text || disabled) return;
    setInput("");
    onSend(text);
  };
  return (
    <div className="flex flex-none flex-col gap-2 border-t border-line px-5 pt-4 pb-5">
      <div className="flex items-center gap-2">
        <input
          className="field h-10 min-w-0 flex-1 border-line-strong"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          disabled={disabled}
          placeholder={placeholder}
        />
        <button
          type="button"
          aria-label="Send"
          className="flex h-10 w-10 flex-none cursor-pointer items-center justify-center rounded-sm border-none bg-indigo text-white hover:bg-indigo-hover disabled:cursor-not-allowed disabled:bg-disabled disabled:text-line-strong"
          onClick={submit}
          disabled={disabled}
        >
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
        </button>
      </div>
    </div>
  );
}

function EmptyStateBody({ llm, onPick }: { llm: boolean; onPick: (prompt: string) => void }) {
  return (
    <>
      <div className="rounded-lg border border-line bg-cream px-[18px] py-4">
        <p className="m-0 text-[13px] leading-5">
          Welcome to AssemblyAI Studio. Tell me what your voice agent or workflow should do and I'll
          build the first version.
        </p>
      </div>
      {llm ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs text-subtle">Try one of these</span>
          {STARTERS.map((starter) => (
            <button
              type="button"
              key={starter.label}
              className="starter"
              onClick={() => onPick(starter.prompt)}
            >
              {starter.label}
            </button>
          ))}
        </div>
      ) : (
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
}: Omit<ChatPanelProps, "project" | "onStartWithPrompt"> & { project: string }) {
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: "/studio/chat",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: () => ({ project }),
    }),
    onFinish: onWorkspaceChanged,
  });

  const busy = status === "submitted" || status === "streaming";

  // Prompt queued by the guided pre-project flow — send exactly once.
  const sentInitial = useRef(false);
  useEffect(() => {
    if (sentInitial.current || !initialPrompt || !llmStatus.llm) return;
    sentInitial.current = true;
    void sendMessage({ text: initialPrompt });
    onInitialPromptSent();
  }, [initialPrompt, llmStatus.llm, sendMessage, onInitialPromptSent]);

  const send = (text: string) => {
    if (busy || !llmStatus.llm) return;
    void sendMessage({ text });
  };

  return (
    <>
      {/* StickToBottom follows streamed output but releases when the user
          scrolls up to read, re-engaging once they return to the bottom. */}
      <StickToBottom className="min-h-0 flex-1" initial="instant" resize="smooth">
        <StickToBottom.Content className="flex flex-col gap-4 px-6 py-5">
          {messages.length === 0 && !initialPrompt && (
            <EmptyStateBody llm={llmStatus.llm} onPick={send} />
          )}
          {messages.map((message) => (
            <MessageView key={message.id} message={message} />
          ))}
          {error && <div className="text-[13px] text-err">{error.message}</div>}
          {busy && <div className="text-[13px] text-subtle italic">Working…</div>}
        </StickToBottom.Content>
      </StickToBottom>
      <Composer
        disabled={busy || !llmStatus.llm}
        placeholder="Describe your agent or workflow…"
        onSend={send}
      />
    </>
  );
}

export function ChatPanel(props: ChatPanelProps) {
  return (
    <div className="flex w-[360px] flex-none flex-col border-r border-line bg-panel">
      <div className="px-6 pt-5">
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
        />
      ) : (
        <>
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
            <EmptyStateBody llm={props.llmStatus.llm} onPick={props.onStartWithPrompt} />
          </div>
          <Composer
            disabled={!props.llmStatus.llm}
            placeholder="Describe your agent or workflow…"
            onSend={props.onStartWithPrompt}
          />
        </>
      )}
    </div>
  );
}
