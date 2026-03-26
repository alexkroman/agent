// Copyright 2025 the AAI authors. MIT license.

import { useComputed, useSignal } from "@preact/signals";
import clsx from "clsx";
import type * as preact from "preact";
import type { ToolCallInfo } from "../types.ts";
import {
  BoltIcon,
  ChatBubbleIcon,
  DownloadIcon,
  ExternalLinkIcon,
  SearchIcon,
  TerminalIcon,
} from "./tool-icons.tsx";

type IconComponent = (props: { class?: string }) => preact.JSX.Element;

type ToolConfig = {
  Icon: IconComponent;
  title: string;
  subtitle: (args: Record<string, unknown>) => string;
};

const argField =
  (key: string): ToolConfig["subtitle"] =>
  (args) =>
    String(args[key] ?? "");

const TOOL_CONFIG: Record<string, ToolConfig> = {
  web_search: { Icon: SearchIcon, title: "Web Search", subtitle: argField("query") },
  visit_webpage: { Icon: ExternalLinkIcon, title: "Visit Page", subtitle: argField("url") },
  run_code: {
    Icon: TerminalIcon,
    title: "Run Code",
    subtitle: (args) => {
      const firstLine = String(args.code ?? "").split("\n")[0] ?? "";
      return firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
    },
  },
  fetch_json: { Icon: DownloadIcon, title: "Fetch JSON", subtitle: argField("url") },
  user_input: { Icon: ChatBubbleIcon, title: "Asking User", subtitle: argField("question") },
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

/**
 * Renders a tool invocation with an icon, title, subtitle, and a
 * collapsible result viewer.
 *
 * Built-in tool types (`web_search`, `visit_webpage`, `run_code`,
 * `fetch_json`, `user_input`) get custom icons and labels. Unknown tools
 * fall back to a generic bolt icon.
 *
 * While the tool call is pending a shimmer animation is shown. Once
 * complete, clicking the block expands the formatted JSON result.
 *
 * @example
 * ```tsx
 * <ToolCallBlock toolCall={toolCall} />
 * ```
 *
 * @param props.toolCall  - The tool call to render (see {@link ToolCallInfo}).
 * @param props.className - Additional CSS class names.
 *
 * @public
 */
export function ToolCallBlock({
  toolCall,
  className,
}: {
  toolCall: ToolCallInfo;
  className?: string;
}): preact.JSX.Element {
  const isOpen = useSignal(false);
  const config = TOOL_CONFIG[toolCall.toolName] ?? DEFAULT_CONFIG;
  const isPending = toolCall.status === "pending";
  const title = config.title || toolCall.toolName;
  const canExpand = !isPending && Boolean(toolCall.result);
  const formatted = useComputed(() => (toolCall.result ? formatResult(toolCall.result) : ""));

  return (
    <div class={clsx("flex flex-col", className)}>
      <button
        type="button"
        aria-expanded={canExpand ? isOpen.value : undefined}
        disabled={isPending}
        class={clsx(
          "flex items-center gap-2 px-3 py-2 rounded-aai border border-aai-border bg-aai-surface-faint select-none text-left w-full",
          canExpand && "cursor-pointer",
        )}
        onClick={() => {
          if (canExpand) isOpen.value = !isOpen.value;
        }}
      >
        <config.Icon class="w-4 h-4 text-aai-text-dim shrink-0" />
        <span class={clsx("text-sm font-medium text-aai-text", isPending && "tool-shimmer")}>
          {title}
        </span>
        <span class="text-sm text-aai-text-dim truncate flex-1 min-w-0">
          {config.subtitle(toolCall.args)}
        </span>
        {canExpand && (
          <span class="text-xs text-aai-text-dim shrink-0">
            {isOpen.value ? "\u25BE" : "\u25B8"}
          </span>
        )}
      </button>
      {isOpen.value && (
        <div class="border-x border-b border-aai-border rounded-b-aai bg-aai-surface max-h-64 overflow-auto">
          {toolCall.toolName === "run_code" && toolCall.args.code && (
            <pre class="text-xs text-aai-text p-2 whitespace-pre-wrap border-b border-aai-border font-mono">
              {String(toolCall.args.code)}
            </pre>
          )}
          {formatted.value && (
            <pre class="text-xs text-aai-text-dim p-2 whitespace-pre-wrap">{formatted.value}</pre>
          )}
        </div>
      )}
    </div>
  );
}
