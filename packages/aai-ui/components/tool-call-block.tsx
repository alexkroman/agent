// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import { type ReactNode, useMemo, useState } from "react";
import { useTheme } from "../context.ts";
import type { ToolCallInfo } from "../types.ts";
import { useToolConfig } from "./tool-config-context.ts";

function formatResult(result: string): string {
  try {
    return JSON.stringify(JSON.parse(result), null, 2);
  } catch {
    return result;
  }
}

/**
 * Renders a tool invocation with an optional icon/emoji, title, subtitle, and a
 * collapsible result viewer.
 *
 * Tool display is configured via `ToolConfigContext`. If no config is found
 * for a tool name, the raw tool name is shown as the title.
 *
 * While the tool call is pending a shimmer animation is shown. Once
 * complete, clicking the block expands the formatted JSON result.
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
      const firstLine = String(args.code).split("\n")[0] ?? "";
      return firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
    }
    // For common tools, show a sensible field
    for (const key of ["query", "url", "question"]) {
      if (args[key]) return String(args[key]);
    }
    const summary = JSON.stringify(args);
    return summary.length > 80 ? `${summary.slice(0, 80)}...` : summary;
  }, [toolCall.name, toolCall.args]);

  return (
    <div className={clsx("flex flex-col", className)}>
      <button
        type="button"
        aria-expanded={canExpand ? isOpen : undefined}
        disabled={isPending}
        className={clsx(
          "flex items-center gap-2 px-3 py-2 rounded-aai border select-none text-left w-full",
          canExpand && "cursor-pointer",
        )}
        style={{
          borderColor: theme.border,
          background: "rgba(255,255,255,0.031)",
        }}
        onClick={() => {
          if (canExpand) setIsOpen(!isOpen);
        }}
      >
        {icon && <span className="w-4 h-4 shrink-0 text-center leading-4">{icon}</span>}
        <span
          className={clsx("text-sm font-medium", isPending && "tool-shimmer")}
          style={{ color: theme.text }}
        >
          {title}
        </span>
        <span
          className="text-sm truncate flex-1 min-w-0"
          style={{ color: "rgba(255,255,255,0.422)" }}
        >
          {subtitle}
        </span>
        {canExpand && (
          <span className="text-xs shrink-0" style={{ color: "rgba(255,255,255,0.422)" }}>
            {isOpen ? "\u25BE" : "\u25B8"}
          </span>
        )}
      </button>
      {isOpen && (
        <div
          className="border-x border-b rounded-b-aai max-h-64 overflow-auto"
          style={{
            borderColor: theme.border,
            background: theme.surface,
          }}
        >
          {toolCall.name === "run_code" && Boolean(toolCall.args.code) && (
            <pre
              className="text-xs p-2 whitespace-pre-wrap border-b font-mono"
              style={{ color: theme.text, borderColor: theme.border }}
            >
              {String(toolCall.args.code)}
            </pre>
          )}
          {formatted && (
            <pre
              className="text-xs p-2 whitespace-pre-wrap"
              style={{ color: "rgba(255,255,255,0.422)" }}
            >
              {formatted}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
