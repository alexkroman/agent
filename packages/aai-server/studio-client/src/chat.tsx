// Copyright 2025 the AAI authors. MIT license.
// Chat pane — `useChat` over the server's UI message stream (SSE).
// Lovable-style: user bubbles, agent prose, tool work as compact rows,
// suggestion chips when the conversation is empty.

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useRef, useState } from "react";
import { ModelPicker, useModelChoice } from "./model-picker.tsx";

type ChatPanelProps = {
  apiKey: string;
  project: string;
  llmStatus: { llm: boolean; provider?: string; model?: string };
  /** Called after each finished assistant turn so the workspace refreshes. */
  onWorkspaceChanged: () => void;
};

const SUGGESTIONS = [
  "Build a pizza ordering agent",
  "Add a tool that rolls dice",
  "Test the agent, then publish it",
];

function toolPartName(part: { type: string; toolName?: string }): string {
  if (part.type === "dynamic-tool") return part.toolName ?? "tool";
  return part.type.replace(/^tool-/, "");
}

function isToolPart(part: { type: string }): boolean {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

function ToolRow({ part }: { part: Record<string, unknown> & { type: string } }) {
  const [open, setOpen] = useState(false);
  const name = toolPartName(part as { type: string; toolName?: string });
  const done = part.state === "output-available";
  const output = part.output;
  return (
    <div className="my-1 rounded-lg border border-line bg-ink px-2.5 py-1.5 text-xs">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-left font-mono text-xs text-dim"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={done ? "text-accent" : ""}>{done ? "✓" : "⏳"}</span>
        {name}
        <span className="ml-auto">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-1 text-dim">
          {part.input != null && (
            <code className="block overflow-x-auto font-mono text-[11px] break-all whitespace-pre-wrap">
              {JSON.stringify(part.input).slice(0, 300)}
            </code>
          )}
          {done && output != null && (
            <pre className="m-0 mt-1 block overflow-x-auto font-mono text-[11px] break-all whitespace-pre-wrap">
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
        <div className="max-w-[85%] rounded-2xl bg-ink px-3.5 py-2 break-words whitespace-pre-wrap">
          {text}
        </div>
      </div>
    );
  }
  return (
    <div className="break-words whitespace-pre-wrap">
      {toBlocks(message).map((block) =>
        block.kind === "text" ? (
          <p className="my-1" key={block.key}>
            {block.text}
          </p>
        ) : (
          <ToolRow key={block.key} part={block.part} />
        ),
      )}
    </div>
  );
}

export function ChatPanel({ apiKey, project, llmStatus, onWorkspaceChanged }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const model = useModelChoice(apiKey);

  // `body` is read per request but the transport may outlive a render, so go
  // through a ref to be sure each turn sends the currently-selected model.
  const choiceRef = useRef(model.choice);
  choiceRef.current = model.choice;

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: "/studio/chat",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: () => ({ project, ...choiceRef.current }),
    }),
    onFinish: onWorkspaceChanged,
    onData: () => {
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
    },
  });

  const busy = status === "submitted" || status === "streaming";

  const send = (text: string) => {
    if (!text.trim() || busy || !llmStatus.llm) return;
    setInput("");
    void sendMessage({ text: text.trim() });
    requestAnimationFrame(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }));
  };

  return (
    <div className="flex w-[400px] shrink-0 flex-col border-r border-line">
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4" ref={logRef}>
        {messages.length === 0 && (
          <div className="mt-6 flex flex-col items-start gap-2">
            <p className="m-0 text-[15px] font-medium">What should your voice agent do?</p>
            <p className="m-0 mb-2 text-[13px] text-dim">
              Describe it and the coding agent will write, test, and publish it.
            </p>
            {llmStatus.llm &&
              SUGGESTIONS.map((suggestion) => (
                <button
                  type="button"
                  key={suggestion}
                  className="chip"
                  onClick={() => send(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
          </div>
        )}
        {messages.map((message) => (
          <MessageView key={message.id} message={message} />
        ))}
        {error && <div className="text-err">{error.message}</div>}
        {busy && <div className="text-dim italic">Working…</div>}
      </div>
      <div className="border-t border-line p-3">
        {llmStatus.llm && (
          <div className="mb-1.5 flex items-center">
            <ModelPicker {...model} disabled={busy} />
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <input
            className="field min-w-0 flex-1"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send(input);
            }}
            disabled={!llmStatus.llm}
            placeholder={
              llmStatus.llm
                ? "Ask Studio…"
                : "Chat disabled: server has no LLM key (ASSEMBLYAI_API_KEY or ANTHROPIC_API_KEY)"
            }
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => send(input)}
            disabled={busy || !llmStatus.llm}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}
