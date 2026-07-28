// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import { type ReactNode, useMemo, useState } from "react";
import { truncate, tryParseJSON } from "../_utils.ts";
import { useTheme } from "../context.ts";
import type { ToolCallInfo } from "../types.ts";
import { TEXT_FAINT, TEXT_MUTED } from "./_colors.ts";
import { useToolConfig } from "./tool-config-context.ts";

function formatResult(result: string): string {
  const parsed = tryParseJSON(result);
  return parsed === result ? result : JSON.stringify(parsed, null, 2);
}

/**
 * Renders a tool invocation as the design system's console row: a small
 * outlined "TOOL" chip (or the tool's configured icon), the tool name in
 * mono, a truncated args preview, and a rotating chevron that expands the
 * formatted result.
 *
 * Tool display is configured via `ToolConfigContext`. If no config is found
 * for a tool name, the raw tool name is shown as the title.
 *
 * While the tool call is pending a shimmer animation is shown. Once
 * complete, clicking the row expands the formatted JSON result.
 *
 * @example
 * ```tsx
 * <ToolCallBlock toolCall={toolCall} />
 * ```
 *
 * @param toolCall - The tool call to render (see {@link ToolCallInfo}).
 * @param className - Additional CSS class names.
 *
 * @public
 */
export function ToolCallBlock({
  toolCall,
  className,
}: {
  toolCall: ToolCallInfo;
  className?: string;
}): ReactNode {
  const [isOpen, setIsOpen] = useState(false);
  const theme = useTheme();
  const toolConfig = useToolConfig();

  const config = toolConfig[toolCall.name];
  const isPending = toolCall.status === "pending";
  const title = config?.label || toolCall.name;
  const icon = config?.icon;
  const canExpand = !isPending && Boolean(toolCall.result);
  const formatted = useMemo(
    () => (toolCall.result ? formatResult(toolCall.result) : ""),
    [toolCall.result],
  );

  const subtitle = useMemo(() => {
    const args = toolCall.args;
    if (toolCall.name === "run_code" && args.code) {
      return truncate(String(args.code).split("\n")[0] ?? "");
    }
    // For common tools, show a sensible field
    for (const key of ["query", "url", "question"]) {
      if (args[key]) return String(args[key]);
    }
    return truncate(JSON.stringify(args));
  }, [toolCall.name, toolCall.args]);

  return (
    <div
      className={clsx("flex flex-col rounded-md border overflow-hidden", className)}
      style={{ borderColor: theme.border, background: theme.bg }}
    >
      <button
        type="button"
        aria-expanded={canExpand ? isOpen : undefined}
        disabled={isPending}
        className={clsx(
          "flex items-center gap-2.5 px-3.5 py-2.5 select-none text-left w-full appearance-none border-none bg-transparent",
          canExpand && "cursor-pointer",
        )}
        onClick={() => {
          if (canExpand) setIsOpen(!isOpen);
        }}
      >
        {icon ? (
          <span className="w-4 h-4 shrink-0 text-center leading-4">{icon}</span>
        ) : (
          <span
            className="text-[10px] font-medium tracking-[1.2px] uppercase leading-none px-1.5 py-[3px] rounded-aai border shrink-0"
            style={{ color: TEXT_FAINT, borderColor: theme.border }}
          >
            Tool
          </span>
        )}
        <span
          className={clsx("font-aai-mono text-[13px] font-medium", isPending && "tool-shimmer")}
          style={{ color: theme.text }}
        >
          {title}
        </span>
        <span
          className="font-aai-mono text-[13px] truncate flex-1 min-w-0"
          style={{ color: TEXT_FAINT }}
        >
          {subtitle}
        </span>
        {canExpand && (
          <span
            className={clsx(
              "text-[10px] shrink-0 transition-transform duration-150",
              isOpen && "rotate-90",
            )}
            style={{ color: TEXT_FAINT }}
          >
            ▶
          </span>
        )}
      </button>
      {isOpen && (
        <div
          className="border-t max-h-64 overflow-auto"
          style={{ borderColor: theme.border, background: theme.surface }}
        >
          {toolCall.name === "run_code" && Boolean(toolCall.args.code) && (
            <pre
              className="font-aai-mono text-xs px-3.5 py-3 m-0 whitespace-pre-wrap wrap-break-word border-b"
              style={{ color: theme.text, borderColor: theme.border }}
            >
              {String(toolCall.args.code)}
            </pre>
          )}
          {formatted && (
            <pre
              className="font-aai-mono text-xs px-3.5 py-3 m-0 whitespace-pre-wrap wrap-break-word"
              style={{ color: TEXT_MUTED }}
            >
              {formatted}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
