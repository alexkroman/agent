// Copyright 2025 the AAI authors. MIT license.
// Chat panel — `useChat` over the server's UI message stream (SSE).

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useRef, useState } from "react";

type ChatPanelProps = {
  apiKey: string;
  project: string;
  llmStatus: { llm: boolean; provider?: string; model?: string };
  /** Called after each finished assistant turn so the editor can refresh. */
  onWorkspaceChanged: () => void;
};

function toolPartName(part: { type: string; toolName?: string }): string {
  if (part.type === "dynamic-tool") return part.toolName ?? "tool";
  return part.type.replace(/^tool-/, "");
}

function isToolPart(part: { type: string }): boolean {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

function ToolPart({ part }: { part: Record<string, unknown> & { type: string } }) {
  const name = toolPartName(part as { type: string; toolName?: string });
  const state = part.state as string | undefined;
  const output = part.output;
  const input = part.input;
  return (
    <div className="my-1 border-l-2 border-line pl-2 text-xs text-dim">
      <span className="font-mono">
        {state === "output-available" ? "✓" : "…"} {name}
      </span>
      {input != null && (
        <code className="mt-0.5 block overflow-x-auto font-mono text-[11px] break-all whitespace-pre-wrap">
          {JSON.stringify(input).slice(0, 200)}
        </code>
      )}
      {state === "output-available" && output != null && (
        <pre className="mt-0.5 block overflow-x-auto font-mono text-[11px] break-all whitespace-pre-wrap">
          {(typeof output === "string" ? output : JSON.stringify(output)).slice(0, 400)}
        </pre>
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
  const isUser = message.role === "user";
  return (
    <div className="break-words whitespace-pre-wrap">
      <span className={`block font-mono text-[11px] ${isUser ? "text-accent" : "text-dim"}`}>
        {isUser ? "you" : "agent"}
      </span>
      {toBlocks(message).map((block) =>
        block.kind === "text" ? (
          <p className="my-0.5" key={block.key}>
            {block.text}
          </p>
        ) : (
          <ToolPart key={block.key} part={block.part} />
        ),
      )}
    </div>
  );
}

export function ChatPanel({ apiKey, project, llmStatus, onWorkspaceChanged }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: "/studio/chat",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: () => ({ project }),
    }),
    onFinish: onWorkspaceChanged,
    onData: () => {
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
    },
  });

  const busy = status === "submitted" || status === "streaming";

  const submit = () => {
    const text = input.trim();
    if (!text || busy || !llmStatus.llm) return;
    setInput("");
    void sendMessage({ text });
    requestAnimationFrame(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }));
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2 p-2.5">
      <h2 className="pane-title flex items-baseline gap-2">
        Coding agent
        {llmStatus.llm && llmStatus.model && (
          <span className="font-mono normal-case tracking-normal">
            {llmStatus.provider}/{llmStatus.model}
          </span>
        )}
      </h2>
      <div
        className="flex flex-1 flex-col gap-2.5 overflow-y-auto rounded-md border border-line bg-panel p-2.5"
        ref={logRef}
      >
        {messages.map((message) => (
          <MessageView key={message.id} message={message} />
        ))}
        {error && <div className="text-err">{error.message}</div>}
        {busy && <div className="text-dim italic">thinking…</div>}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          className="field min-w-0 flex-1"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          disabled={!llmStatus.llm}
          placeholder={
            llmStatus.llm
              ? "Describe the voice agent you want to build…"
              : "Chat disabled: server has no LLM key (ASSEMBLYAI_API_KEY or ANTHROPIC_API_KEY)"
          }
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={submit}
          disabled={busy || !llmStatus.llm}
        >
          Send
        </button>
      </div>
    </div>
  );
}
