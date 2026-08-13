// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:workflow` epoch 3.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * Epoch 2 added the two client METHODS that reach a run already going
 * (`streamOutput`, `wake`); epoch 3 adds the HOOK a page actually renders from.
 * `useWorkflowProgress` is the `useWorkflowRun` of what a run WROTE rather than
 * where it got to, and the two are meant to be used together — which is what
 * this example shows. Both earlier epochs still compile beside it.
 */

import {
  type UseWorkflowProgressResult,
  useWorkflowProgress,
  useWorkflowRun,
} from "../../../index.ts";

type Digest = { headline: string };

/**
 * The pair, as a page uses them: status decides what to SAY, progress decides
 * what to SHOW while it is saying it.
 */
export function Watcher({ runId }: { runId?: string }) {
  const { run, polling } = useWorkflowRun<Digest>(runId);
  const result: UseWorkflowProgressResult = useWorkflowProgress(runId);
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

/** A workflow writing objects rather than lines names its own shape. */
type Step = { step: number; of: number };

export function TypedProgress({ runId }: { runId: string }) {
  const { latest } = useWorkflowProgress<Step>(runId, { namespace: "progress", startIndex: -1 });
  return <p>{latest ? `${latest.step} of ${latest.of}` : "starting"}</p>;
}
