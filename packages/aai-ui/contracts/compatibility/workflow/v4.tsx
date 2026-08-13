// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:workflow` epoch 4.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * Epoch 4 adds `DEFAULT_PROGRESS_POLL_MS`, and the constant only exists because
 * a progress read is BOUNDED: a workflow stream reports its end once CLOSED, a
 * progress channel written by one step after another never is, so the hook
 * re-opens from where it got to rather than holding one response open. This is
 * the interval between those reads, and it is exported for the same reason
 * `DEFAULT_WORKFLOW_POLL_MS` is — a page that wants a slower cadence should be
 * able to say "twice the default" rather than pick a number.
 *
 * Epoch 3's example still compiles beside this one; what it could not express is
 * a page choosing its own cadence relative to the shipped one.
 */

import {
  DEFAULT_PROGRESS_POLL_MS,
  type UseWorkflowProgressResult,
  useWorkflowProgress,
  useWorkflowRun,
} from "../../../index.ts";

type Digest = { headline: string };

/** The constant, used the way it is meant to be: relative, not replaced. */
const BACKGROUND_TAB_MS = DEFAULT_PROGRESS_POLL_MS * 4;

export function Watcher({ runId, background }: { runId?: string; background?: boolean }) {
  const { run, polling } = useWorkflowRun<Digest>(runId);
  const result: UseWorkflowProgressResult = useWorkflowProgress(runId, {
    intervalMs: background === true ? BACKGROUND_TAB_MS : DEFAULT_PROGRESS_POLL_MS,
  });
  const { progress, latest, streaming, supported } = result;

  if (run?.status === "completed") return <p>{run.output.headline}</p>;
  return (
    <section>
      {polling && <p>Working…</p>}
      {/* `supported` distinguishes "this deploy serves no progress stream" from
          "the run has written nothing yet", which `progress` alone cannot. */}
      {supported && latest !== undefined && <p>{latest}</p>}
      {supported && progress.length > 0 && (
        <pre>
          {progress.join("\n")}
          {streaming && "\n…"}
        </pre>
      )}
    </section>
  );
}
