// Copyright 2025 the AAI authors. MIT license.
import type * as preact from "preact";
import { useState } from "preact/hooks";
import type { ToolCallInfo } from "../types.ts";
import {
  BoltIcon,
  ChatBubbleIcon,
  DownloadIcon,
  ExternalLinkIcon,
  SearchIcon,
  TerminalIcon,
} from "./tool_icons.tsx";

type IconComponent = (props: { class?: string }) => preact.JSX.Element;

type ToolConfig = {
  Icon: IconComponent;
  title: string;
  subtitle: (args: Record<string, unknown>) => string;
};

const TOOL_CONFIG: Record<string, ToolConfig> = {
  web_search: {
    Icon: SearchIcon,
    title: "Web Search",
    subtitle: (args) => String(args.query ?? ""),
  },
  visit_webpage: {
    Icon: ExternalLinkIcon,
    title: "Visit Page",
    subtitle: (args) => String(args.url ?? ""),
  },
  run_code: {
    Icon: TerminalIcon,
    title: "Run Code",
    subtitle: (args) => {
      const code = String(args.code ?? "");
      const firstLine = code.split("\n")[0] ?? "";
      return firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
    },
  },
  fetch_json: {
    Icon: DownloadIcon,
    title: "Fetch JSON",
    subtitle: (args) => String(args.url ?? ""),
  },
  user_input: {
    Icon: ChatBubbleIcon,
    title: "Asking User",
    subtitle: (args) => String(args.question ?? ""),
  },
};

const DEFAULT_CONFIG: ToolConfig = {
  Icon: BoltIcon,
  title: "",
  subtitle: (args) => {
    const summary = JSON.stringify(args);
    return summary.length > 80 ? `${summary.slice(0, 80)}...` : summary;
  },
};

function formatResult(result: string): string {
  try {
    return JSON.stringify(JSON.parse(result), null, 2);
  } catch {
    return result;
  }
}

export function ToolCallBlock({ toolCall }: { toolCall: ToolCallInfo }): preact.JSX.Element {
  const [isOpen, setOpen] = useState(false);
  const config = TOOL_CONFIG[toolCall.toolName] ?? DEFAULT_CONFIG;
  const isPending = toolCall.status === "pending";
  const title = config.title || toolCall.toolName;

  return (
    <div class="flex flex-col">
      <div
        class="flex items-center gap-2 px-3 py-2 rounded-aai border border-aai-border bg-aai-surface-faint cursor-pointer select-none"
        onClick={() => !isPending && setOpen(!isOpen)}
      >
        <config.Icon class="w-4 h-4 text-aai-text-dim shrink-0" />
        <span class={`text-sm font-medium text-aai-text ${isPending ? "tool-shimmer" : ""}`}>
          {title}
        </span>
        <span class="text-sm text-aai-text-dim truncate flex-1 min-w-0">
          {config.subtitle(toolCall.args)}
        </span>
        {!isPending && toolCall.result && (
          <span class="text-xs text-aai-text-dim shrink-0">{isOpen ? "\u25BE" : "\u25B8"}</span>
        )}
      </div>
      {isOpen && (
        <div class="border-x border-b border-aai-border rounded-b-aai bg-aai-surface max-h-64 overflow-auto">
          {toolCall.toolName === "run_code" && toolCall.args.code && (
            <pre class="text-xs text-aai-text p-2 whitespace-pre-wrap border-b border-aai-border font-mono">
              {String(toolCall.args.code)}
            </pre>
          )}
          {toolCall.result && (
            <pre class="text-xs text-aai-text-dim p-2 whitespace-pre-wrap">
              {formatResult(toolCall.result)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
