// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import { memo, type ReactNode, useMemo } from "react";
import { truncate, tryParseJSON } from "../_utils.ts";
import { useTheme } from "../context.ts";
import type { ToolCallInfo } from "../types.ts";
import { INK_MUTED_PCT, inkTint } from "./_colors.ts";
import { ToolCallRow } from "./tool-call-row.tsx";
import { useToolConfig } from "./tool-config-context.ts";

function formatResult(result: string): string {
  const parsed = tryParseJSON(result);
  return parsed === result ? result : JSON.stringify(parsed, null, 2);
}

/**
 * The expanded result pane.
 *
 * Its own component so the parse-and-pretty-print happens only when the row is
 * actually OPEN. `ToolCallRow` renders `children` under `isOpen && canExpand`,
 * and a row starts closed — so computing this in the parent meant every row
 * paid `JSON.parse` + `JSON.stringify(_, null, 2)` over its whole result, and
 * then RETAINED the pretty string, for a panel nobody clicked. The burst case
 * is `history.restored`, which mounts up to `DEFAULT_MAX_HISTORY` rows in one
 * commit.
 *
 * Creating this element is free; React only runs the body once it is mounted.
 */
function ToolCallResult({ result }: { result: string }): ReactNode {
  const theme = useTheme();
  const formatted = useMemo(() => formatResult(result), [result]);
  if (!formatted) return null;
  return (
    <pre
      className="font-aai-mono text-xs px-3.5 py-3 m-0 whitespace-pre-wrap wrap-break-word"
      style={{ color: inkTint(theme.text, theme.surface, INK_MUTED_PCT) }}
    >
      {formatted}
    </pre>
  );
}

/**
 * Renders a tool invocation as the design system's console row (see
 * `ToolCallRow`): a small outlined "TOOL" chip (or the tool's configured
 * icon), the tool name in mono, a truncated args preview, and a rotating
 * chevron that expands the formatted result.
 *
 * Tool display is configured via `ToolConfigContext`. If no config is found
 * for a tool name, the raw tool name is shown as the title.
 *
 * While the tool call is pending a shimmer animation is shown. Once
 * complete, clicking the row expands the formatted JSON result.
 *
 * Memoized: tool-call objects are referentially stable across session
 * snapshots and rows are keyed on the stable `callId`, so a list update only
 * re-renders the rows whose tool call actually changed.
 *
 * @param toolCall - The tool call to render (see {@link ToolCallInfo}).
 * @param className - Additional CSS class names.
 *
 * @internal Not exported from the package — rendered by `MessageList`.
 */
export const ToolCallBlock = memo(function ToolCallBlock({
  toolCall,
  className,
}: {
  toolCall: ToolCallInfo;
  className?: string;
}): ReactNode {
  const theme = useTheme();
  const toolConfig = useToolConfig();

  // Own-property lookup: the tool name comes off the wire, so a name like
  // "constructor" must not resolve through the object's prototype chain.
  const config = Object.hasOwn(toolConfig, toolCall.name) ? toolConfig[toolCall.name] : undefined;
  const isPending = toolCall.status === "pending";
  const title = config?.label || toolCall.name;
  const icon = config?.icon;
  const canExpand = !isPending && Boolean(toolCall.result);

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
    <ToolCallRow
      title={title}
      detail={subtitle}
      pending={isPending}
      icon={icon}
      className={className}
    >
      {canExpand ? (
        <>
          {toolCall.name === "run_code" && Boolean(toolCall.args.code) && (
            <pre
              className="font-aai-mono text-xs px-3.5 py-3 m-0 whitespace-pre-wrap wrap-break-word border-b"
              style={{ color: theme.text, borderColor: theme.border }}
            >
              {String(toolCall.args.code)}
            </pre>
          )}
          {toolCall.result && <ToolCallResult result={toolCall.result} />}
        </>
      ) : undefined}
    </ToolCallRow>
  );
});
