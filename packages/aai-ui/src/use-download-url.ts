// Copyright 2026 the AAI authors. MIT license.
/**
 * `useDownloadUrl` — an upload id a run produced, as something `<audio>`,
 * `<img>` or `<a download>` will accept.
 *
 * `api.download(id)` resolves a `Blob`, and it has to: the byte route takes the
 * same bearer every workflow route does, and neither `<audio src>` nor
 * `<a href>` can send one. So every page that plays back what a run WROTE ends
 * up at the same four lines — `download` → `createObjectURL` → state — and the
 * two that are really the point are the two the four lines are wrapped in:
 *
 * - **`URL.revokeObjectURL` on cleanup.** An object URL pins its blob for the
 *   life of the DOCUMENT. Miss it and every completed run's audio stays resident
 *   until the tab closes, which on a page people run all day is a leak measured
 *   in the size of the files.
 * - **A `cancelled` flag.** A second run settling while the first download is
 *   still in flight otherwise sets state from the stale one, and the page plays
 *   the previous run's audio under the current run's transcript — a wrong answer
 *   that looks like a right one.
 *
 * Two templates had written this hook, identically, doc paragraph included, and
 * `aai-ui` exported no download helper at all. Both also faked `pending` by
 * checking `url === undefined && error === undefined`, which reads "idle" and
 * "downloading" as the same thing — so this reports it.
 */

import { errorMessage } from "@alexkroman1/aai";
import { useEffect, useState } from "react";
import { useWorkflowApiRef } from "./_workflow-api-ref.ts";
import type { WorkflowApi } from "./workflow-client.ts";

/** Options for {@link useDownloadUrl}. */
export type UseDownloadUrlOptions = {
  /** The client to read the bytes with. Defaults to one for the page's own agent. */
  api?: WorkflowApi;
};

/**
 * What {@link useDownloadUrl} reports.
 *
 * @public
 */
export type UseDownloadUrlResult = {
  /**
   * An object URL for the stored bytes, once they are here. Valid until the id
   * changes or the component unmounts — do not stash it anywhere that outlives
   * the render that read it.
   */
  url?: string;
  /** The read's failure, as the agent's own sentence where it gave one. */
  error?: string;
  /**
   * True while the bytes are on their way.
   *
   * Its own field rather than "neither `url` nor `error`", which cannot tell a
   * download in flight from no id to download — the two states a page most
   * wants to render differently (a spinner, and nothing at all).
   */
  pending: boolean;
};

/** No id: nothing pending, nothing to show. A shared object so `setState` no-ops. */
const IDLE: UseDownloadUrlResult = { pending: false };
/** Bytes in flight. Shared for the same reason as {@link IDLE}. */
const PENDING: UseDownloadUrlResult = { pending: true };

/**
 * Read an upload's bytes and hand back a URL a DOM element can use.
 *
 * @param uploadId - The id a completed run reported, or `undefined` before one
 *   exists — which is what a page passes straight through while it waits, and
 *   reports as idle rather than pending.
 * @param options - See {@link UseDownloadUrlOptions}.
 * @returns See {@link UseDownloadUrlResult}.
 *
 * @example
 * ```tsx no-check
 * import { useDownloadUrl, useWorkflowSubmit } from "@alexkroman1/aai-ui";
 * import type { spokenSummary } from "./agent.ts";
 *
 * function Playback() {
 *   const { run } = useWorkflowSubmit<typeof spokenSummary>("spokenSummary");
 *   const output = run?.status === "completed" ? run.output : undefined;
 *   const audio = useDownloadUrl(output?.audio);
 *   if (audio.pending) return <p>Fetching audio…</p>;
 *   if (audio.error !== undefined) return <p role="alert">{audio.error}</p>;
 *   return audio.url === undefined ? null : (
 *     <a href={audio.url} download="summary.mp3">
 *       Download
 *     </a>
 *   );
 * }
 * ```
 *
 * @public
 */
export function useDownloadUrl(
  uploadId: string | undefined,
  options: UseDownloadUrlOptions = {},
): UseDownloadUrlResult {
  const [state, setState] = useState<UseDownloadUrlResult>(IDLE);

  // The client through a ref — see `_workflow-api-ref.ts`. A page that builds
  // one in render must not restart this download on every frame.
  const getClient = useWorkflowApiRef(options.api);

  useEffect(() => {
    if (uploadId === undefined) {
      setState(IDLE);
      return;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    setState(PENDING);
    getClient()
      .download(uploadId)
      .then((blob) => {
        // The stale-run guard. Without it the FIRST run's bytes land last and
        // win, under the second run's output.
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, pending: false });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ error: errorMessage(err), pending: false });
      });
    return () => {
      cancelled = true;
      // Revoked even when the download lost the race: `objectUrl` is only set
      // on the branch that created one, so this frees exactly what this run
      // allocated and nothing a later run is still rendering.
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [uploadId, getClient]);

  return state;
}
