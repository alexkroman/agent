// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ReactNode } from "react";
import { useWorkflowProgress } from "../use-workflow-progress.ts";
import type { WorkflowApi } from "../workflow-client.ts";

/**
 * What a run has said so far, rendered.
 *
 * The complement of a status line, and the reason both exist: a run is
 * `running` for its whole life, so a one-round job and a ten-round one look
 * identical while they happen. These lines come from the run itself (`report()`
 * in a `"use step"` body), which is the only channel a workflow has before it
 * produces an output.
 *
 * Three rules are baked in, and they are why this is a component rather than
 * three lines each page writes for itself — the two templates that had written
 * it had written all three, comments included:
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
 * @param runId - The run to read. `undefined` renders nothing, so a page may
 *   pass its state straight through before a run exists.
 * @param api - The workflow API client, when the page holds its own. Defaults
 *   to the one `page()` installs.
 * @param className - Replaces the default classes rather than extending them,
 *   so a custom chrome is not fighting a default it did not ask for.
 * @param placeholder - Rendered instead of nothing while the run has said
 *   nothing yet — for a page that would otherwise reflow when the first line
 *   lands.
 *
 * @public
 */
export function WorkflowProgress({
  runId,
  api,
  className,
  placeholder,
}: {
  runId?: string | undefined;
  api?: WorkflowApi | undefined;
  className?: string | undefined;
  placeholder?: ReactNode | undefined;
}): ReactNode {
  const { progress, streaming, supported } = useWorkflowProgress(runId, api ? { api } : {});

  if (!supported || progress.length === 0) return placeholder ?? null;

  return (
    <pre className={clsx(className ?? "whitespace-pre-wrap border-l pl-4 text-xs opacity-70")}>
      {progress.join("\n")}
      {streaming && "\n…"}
    </pre>
  );
}
