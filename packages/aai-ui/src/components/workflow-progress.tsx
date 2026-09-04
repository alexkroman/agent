// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import { omitUndefined } from "@alexkroman1/aai/utils";
import clsx from "clsx";
import { type ReactNode, useMemo } from "react";
import { useWorkflowProgress } from "../use-workflow-progress.ts";
import type { WorkflowApi } from "../workflow-client.ts";

/**
 * What a run has said so far, rendered.
 *
 * The complement of a status line, and the reason both exist: a run is
 * `running` for its whole life, so a one-round job and a ten-round one look
 * identical while they happen. These lines come from the run itself (`stepReport()`
 * in a `"use step"` body), which is the only channel a workflow has before it
 * produces an output.
 *
 * Four rules are baked in, and they are why this is a component rather than
 * three lines each page writes for itself — the two templates that had written
 * it had written three of them, comments included:
 *
 * - **It renders nothing until there is something to render.** `supported` is
 *   what keeps this from being an empty box forever on an agent deployed before
 *   progress streams existed: "wrote nothing yet" and "serves no stream" are
 *   indistinguishable from the chunk list alone.
 * - **The lines are TEXT, not elements.** They are append-only and two rounds
 *   legitimately produce identical text, so there is no stable per-line key to
 *   give React. Joining sidesteps the question instead of suppressing the lint
 *   rule that asks it.
 * - **They REPLAY.** Chunks are retained with the run, so a reload mid-run —
 *   or opening a finished run tomorrow — shows how it got there rather than an
 *   empty box. That is `useWorkflowProgress`'s doing; this is what makes it
 *   visible.
 * - **They are ANNOUNCED**, for the reason the first paragraph gives: this is
 *   the only channel a run has before it produces an output, and a `<pre>` that
 *   grows is a silent one. A screen-reader user pressing "Digest" got nothing
 *   between the click and a terminal state minutes later — no "fetching", no
 *   "summarising", no evidence the button did anything. See `role="log"` below.
 *   The six pages that render this pass only `className`, so no template could
 *   have fixed it locally; that is what makes it this component's job.
 *
 * @example
 * ```tsx
 * import { WorkflowProgress } from "@alexkroman1/aai-ui";
 *
 * function RunPanel({ runId }: { runId: string }) {
 *   return <WorkflowProgress runId={runId} />;
 * }
 * ```
 *
 * @param props - Progress-log props.
 *
 * @public
 */
export function WorkflowProgress({
  runId,
  api,
  className,
  placeholder,
  lines,
}: {
  /**
   * The run to read. `undefined` renders nothing, so a page may pass its state
   * straight through before a run exists.
   */
  runId?: string | undefined;
  /**
   * The workflow API client, when the page holds its own. Defaults to the
   * lazily-built one every workflow hook shares.
   */
  api?: WorkflowApi | undefined;
  /**
   * **Replaces** the default classes rather than extending them, so a custom
   * chrome is not fighting a default it did not ask for.
   */
  className?: string | undefined;
  /**
   * Rendered instead of nothing while the run has said nothing yet — for a
   * page that would otherwise reflow when the first line lands.
   */
  placeholder?: ReactNode | undefined;
  /**
   * How many of the newest lines to show. Undefined (the default) shows the
   * whole log; `1` is the newest line only.
   *
   * A run's narration is append-only and unbounded, so a page with a fixed slot
   * for it — a status strip, a card footer — wants a window rather than a log.
   * `0` renders the placeholder, which is the consistent reading of "show none"
   * and the one that keeps a computed `lines` from silently rendering
   * everything.
   */
  lines?: number | undefined;
}): ReactNode {
  const { progress, streaming, supported } = useWorkflowProgress(runId, omitUndefined({ api }));

  // Sliced before the emptiness test, so `lines={0}` reads as "nothing to show"
  // rather than as a full log. Joined under the same memo: this renders inside
  // the caller's `<Form>`, which re-renders at upload-progress rate, and the
  // join is O(the whole log) — quadratic across a fan-out that writes a line
  // per item.
  const text = useMemo(() => {
    const shown =
      lines === undefined ? progress : progress.slice(Math.max(progress.length - lines, 0));
    return shown.length === 0 ? null : shown.join("\n");
  }, [progress, lines]);

  if (!supported || text === null) return placeholder ?? null;

  return (
    // `role="log"`, which is `AutoScroll`'s choice for the same shape — the
    // three voice chromes' transcripts are announced because of it, and a run's
    // narration is the same thing: append-only text a reader is waiting on.
    //
    // `role="status"` is the wrong half of the pair here, and not by a hair:
    // its implicit `aria-atomic` is TRUE, so every poll that appends one line
    // would have a screen reader re-read the whole block from the top — which
    // on a fan-out writing a line per item is the reading getting slower as the
    // run gets longer. `log` implies `aria-atomic="false"`, i.e. announce the
    // delta.
    //
    // Both live-region attributes are then stated EXPLICITLY rather than left
    // implicit in the role. A role's implicit `aria-live`/`aria-atomic` is
    // mapped inconsistently across screen readers, and the cost of being wrong
    // here is silence, which is exactly the failure being fixed — so the two
    // attributes that carry the behaviour are written down instead of inferred.
    <pre
      role="log"
      aria-live="polite"
      aria-atomic="false"
      className={clsx(className ?? "whitespace-pre-wrap border-l pl-4 text-xs opacity-70")}
    >
      {text}
      {streaming && "\n…"}
    </pre>
  );
}
