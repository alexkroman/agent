// Copyright 2026 the AAI authors. MIT license.
// A run of consecutive tool calls in one assistant message, folded into a
// single step row. The coding agent reads, lists, writes and builds in bursts
// of five or ten calls between sentences, and a boxed row per call buried the
// two sentences of prose that said what it was doing; the run is one line now
// ("✓ 5 steps · Read file, Write file, Build") that opens to the per-call rows.

import clsx from "clsx";
import { useState } from "react";
import { CheckIcon, ChevronRightIcon, SpinnerIcon } from "./icons.tsx";
import { summarizeArgs, ToolRow, toolTitle } from "./tool-row.tsx";

type ToolPart = Record<string, unknown> & { type: string };

/** A call that has not produced its result yet. */
function isPending(part: ToolPart): boolean {
  return part.state !== "output-available" && part.state !== "output-error";
}

/**
 * The collapsed row's summary: each distinct tool once, in first-use order.
 * Exported for tests.
 */
export function stepSummary(
  parts: readonly ToolPart[],
  labels?: Record<string, string> | undefined,
): string {
  return [...new Set(parts.map((part) => toolTitle(part, labels)))].join(", ");
}

export function ToolGroup({
  parts,
  active,
  labels,
}: {
  parts: readonly ToolPart[];
  /** The turn is still streaming. False once it settles, so an abandoned call never spins. */
  active: boolean;
  labels?: Record<string, string> | undefined;
}) {
  const [open, setOpen] = useState(false);
  // The LAST pending call is the one running: earlier ones in a run settle in
  // order, and a group can only be mid-run at its tail.
  const running = active ? parts.findLast(isPending) : undefined;
  const failed = parts.filter((part) => part.state === "output-error").length;
  const count = `${parts.length} ${parts.length === 1 ? "step" : "steps"}`;
  return (
    <div className="my-1 flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        className="group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-left text-[12px] text-muted hover:border-line-strong hover:text-fg"
        onClick={() => setOpen((v) => !v)}
      >
        {running ? (
          <span className="text-indigo">
            <SpinnerIcon />
          </span>
        ) : (
          <span className={clsx(failed > 0 ? "text-err" : "text-emerald-600")}>
            <CheckIcon />
          </span>
        )}
        {running ? (
          <span className="min-w-0 flex-1 truncate">
            <span className="tool-shimmer font-medium text-fg">{toolTitle(running, labels)}</span>
            <span className="ml-1.5 font-mono text-[11px] text-subtle">
              {summarizeArgs(running.input)}
            </span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium text-fg">{count}</span>
            {failed > 0 && <span className="text-err"> · {failed} failed</span>}
            <span className="text-subtle"> · {stepSummary(parts, labels)}</span>
          </span>
        )}
        <span
          className={clsx("flex text-subtle transition-transform", open && "rotate-90")}
          aria-hidden
        >
          <ChevronRightIcon />
        </span>
      </button>
      {open && (
        <div className="mt-1 ml-3 border-l border-line pl-2.5">
          {parts.map((part, i) => (
            <ToolRow
              key={String(part.toolCallId ?? i)}
              part={part}
              active={active}
              labels={labels}
            />
          ))}
        </div>
      )}
    </div>
  );
}
