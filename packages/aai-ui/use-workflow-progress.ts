// Copyright 2026 the AAI authors. MIT license.
/**
 * `useWorkflowProgress` — read what a run has WRITTEN while it runs.
 *
 * The sibling of `useWorkflowRun`, and the split between them is the whole
 * reason this exists. That hook reports a run's STATE: the status transitions
 * the world records, which every run has. This reports what the run itself
 * wrote through `getWritable()`, which is the only thing a long run can say
 * before it finishes — a snapshot carries a status and, once terminal, an
 * output, and nothing in between. A page that shows only status shows
 * "Working…" for ten minutes and then a result.
 *
 * ## There is no poll fallback, and that is not an omission
 *
 * `useWorkflowRun` degrades to polling `GET /runs/:id` because a run's STATE is
 * readable that way. A run's written chunks are not: the stream is the only
 * route to them, so an agent that does not serve it has no progress to give and
 * `supported` says so once, rather than a poll pretending to look for something
 * that is not there. A page renders its status line either way.
 *
 * ## Chunks are RETAINED, so this is a replay as much as a tail
 *
 * The run's stream keeps every chunk, so a page that mounts late — a reload, a
 * second tab, a link opened tomorrow — reads the whole history from index 0 and
 * arrives at the same list as one that watched throughout. That is what makes a
 * durable run's progress durable too, and it is why the default `startIndex` is
 * 0 rather than "from now": a tail-only default would make the same page show
 * different things depending on when it opened.
 *
 * ## It RE-OPENS while the run is live, because a progress read is bounded
 *
 * The route answers with the chunks written when the request arrived and then
 * ends, reporting `complete` — whether the run itself was terminal. It has to:
 * a workflow stream signals its end only once CLOSED, and a progress channel
 * written by one step after another is never closed, so a read that waited for
 * the end would hang forever on a finished run. (It did: see the route's own
 * doc.)
 *
 * So this hook re-opens from where it left off until a read comes back
 * `complete`. That is a poll, and the honest description of progress is a durable
 * log rather than a socket — but it is a poll of a CHEAP shape: each read asks
 * only for chunks past the last index it saw, so a quiet run costs an empty
 * answer rather than the whole log again.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { useEffect, useState } from "react";
import { repeatUntil } from "./_repeat-until.ts";
import { sseFrames } from "./_sse.ts";
import { useWorkflowApiRef } from "./_workflow-api-ref.ts";
import type { WorkflowApi } from "./workflow-client.ts";

/** The slice of the client this needs: one method. */
export type RunProgressReader = Pick<WorkflowApi, "streamOutput">;

export type UseWorkflowProgressResult<T = string> = {
  /** Every chunk the run has written, oldest first. */
  progress: T[];
  /** The newest chunk, or undefined before the first one lands. */
  latest: T | undefined;
  /** True while the run is still being read — it may yet say more. */
  streaming: boolean;
  /**
   * False once the agent has answered that it does not serve this route.
   *
   * Distinguishes "this deploy predates progress streams" from "the run has not
   * written anything yet", which look identical from `progress` alone. A page
   * uses it to hide the section rather than show an empty one forever.
   */
  supported: boolean;
};

/** How often a live run's progress is re-read once a bounded read has ended. */
export const DEFAULT_PROGRESS_POLL_MS = 1000;

/** What one bounded read reported. */
type Ending =
  /** The RUN is terminal — nothing more will ever be written. */
  | "complete"
  /** This read ended at its budget; the run is still going. */
  | "partial"
  /** The agent does not serve the route. */
  | "unsupported";

/**
 * Drain one bounded read's frames, reporting how it ended and everything it
 * carried.
 *
 * The chunks are RETURNED rather than handed over one at a time, and that is
 * what lets the hook commit a whole read in one React update: a per-chunk
 * callback re-rendered the page once per progress line and rebuilt the list
 * each time, which for a fan-out writing a line per segment is an O(n²) copy of
 * the log a reader can already only see one frame at a time. A read is bounded
 * by construction (see the module doc), so buffering one is bounded too.
 */
async function consumeFrames<T>(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<{ ending: Ending; chunks: T[] }> {
  const chunks: T[] = [];
  let ending: Ending = "partial";
  for await (const frame of sseFrames(body, signal)) {
    if (frame.event === "chunk") {
      chunks.push(frame.data as T);
    } else if (frame.event === "done") {
      // `complete` on the `done` frame is the RUN's state, not the read's: a
      // bounded read always ends, and only this says whether to come back.
      ending = (frame.data as { complete?: boolean } | undefined)?.complete
        ? "complete"
        : "partial";
    } else if (frame.event === "missing") {
      // The id will never exist, so there is nothing to come back for.
      return { ending: "complete", chunks };
    }
  }
  return { ending, chunks };
}

/**
 * Read one run's progress until it is complete, reporting each read's chunks.
 *
 * Module-level rather than inline in the hook, so the loop reads without React in
 * the way — the same split `useWorkflowRun` makes with `pollUntilTerminal`.
 *
 * Every re-open asks from an ABSOLUTE position past the last chunk read, so a
 * read only ever fetches what this reader has not seen. That is what keeps the
 * poll cheap: a quiet run answers with a bare `done` rather than the whole log
 * again.
 *
 * ## A negative `startIndex` is resolved on the FIRST read, not carried
 *
 * "The last N lines" names no position a later read can resume from — the tail
 * it counts back from moves with every line the run writes. Carrying it meant a
 * re-open asking for everything from 0 and dropping `seen` chunks off the
 * FRONT, which is a different set entirely: a reader that opened at
 * `startIndex: -3` on a 10-line log holds lines 7-9, and its next read handed
 * over lines 3 onwards — four lines it never asked for, then the three it
 * already had, in that order. The dedupe the old comment claimed would need the
 * first read's absolute tail, which the reader never learned.
 *
 * So the first read is issued from 0 instead, and only its last N chunks are
 * handed over. The window the caller asked for is unchanged, and the reader now
 * knows exactly where it is — every read after it is the ordinary absolute case.
 * The cost is that the first read transfers the whole log, which is what the
 * DEFAULT (`startIndex: 0`, "replay everything") already does.
 */
function readProgressUntilComplete<T>(
  getClient: () => RunProgressReader,
  runId: string,
  options: { namespace?: string | undefined; startIndex?: number | undefined },
  intervalMs: number,
  onChunks: (chunks: T[]) => void,
  onEnded: (ending: Ending) => void,
): () => void {
  const start = options.startIndex ?? 0;
  // How many trailing chunks of the first read the caller actually asked for,
  // for a negative `startIndex` only. Everything else takes the whole read.
  const tail = start < 0 ? -start : undefined;
  // The absolute index the NEXT read starts at. A negative start reads from 0
  // and trims, so its cursor starts at 0 too — see the doc above.
  let next = tail === undefined ? start : 0;
  let firstRead = true;

  /** One bounded read. Resolves how it ended. */
  const readOnce = async (signal: AbortSignal): Promise<Ending> => {
    // `omitUndefined` rather than a spread: under `exactOptionalPropertyTypes` a
    // present-and-undefined `namespace` is not the same as an absent one, and the
    // client would put an empty parameter on the query string. Index 0 is left
    // off for the same reason — it is what the route does with no parameter.
    const res = await getClient().streamOutput(runId, {
      ...omitUndefined({
        namespace: options.namespace,
        startIndex: next === 0 ? undefined : next,
      }),
      signal,
    });
    // A non-2xx, or a body-less response, is an agent that does not serve this —
    // the ordinary case for one deployed before the route existed, and also what
    // a 404 for an unknown run looks like.
    if (!(res.ok && res.body)) return "unsupported";
    const { ending, chunks } = await consumeFrames<T>(res.body, signal);
    next += chunks.length;
    const fresh = firstRead && tail !== undefined ? chunks.slice(-tail) : chunks;
    firstRead = false;
    if (fresh.length > 0 && !signal.aborted) onChunks(fresh);
    return ending;
  };

  return repeatUntil(intervalMs, async (signal) => {
    let ending: Ending;
    try {
      ending = await readOnce(signal);
    } catch {
      // A thrown fetch is a transport failure, not an absent route — and not a
      // reason to stop watching a live run, so it is retried like a `partial`.
      ending = "partial";
    }
    if (signal.aborted) return true;
    if (ending === "partial") return false;
    onEnded(ending);
    return true;
  });
}

/**
 * Follow one run's progress stream.
 *
 * Passing `undefined` (nothing started yet) costs nothing, and reading stops for
 * good once a read reports the run terminal — so a finished run costs one read.
 *
 * @example
 * ```tsx
 * import { useWorkflowProgress } from "@alexkroman1/aai-ui";
 *
 * function Progress({ runId }: { runId?: string }) {
 *   const { progress, streaming, supported } = useWorkflowProgress(runId);
 *   if (!supported) return null;
 *   return (
 *     <pre>
 *       {progress.join("\n")}
 *       {streaming && "\n…"}
 *     </pre>
 *   );
 * }
 * ```
 *
 * @typeParam T - What the workflow writes. Defaults to `string`, which is what
 *   a progress channel usually carries; a workflow writing objects names its own
 *   shape. Nothing in the browser can verify it — the route describes no type —
 *   so this is the page's assertion about its own agent, narrowed once here
 *   rather than at every read.
 *
 * @public
 */
export function useWorkflowProgress<T = string>(
  runId: string | undefined,
  opts: {
    api?: WorkflowApi;
    namespace?: string;
    startIndex?: number;
    intervalMs?: number;
  } = {},
): UseWorkflowProgressResult<T> {
  const { api, namespace, startIndex, intervalMs = DEFAULT_PROGRESS_POLL_MS } = opts;
  const [progress, setProgress] = useState<T[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [supported, setSupported] = useState(true);

  // The caller's client through a ref — see `_workflow-api-ref.ts` for why it
  // may not be an effect dependency.
  const getClient = useWorkflowApiRef(api);

  useEffect(() => {
    // A new id must not show the previous run's lines for a frame.
    setProgress([]);
    setSupported(true);
    setStreaming(false);
    if (!runId) return;
    setStreaming(true);
    const stop = readProgressUntilComplete<T>(
      getClient,
      runId,
      { namespace, startIndex },
      intervalMs,
      // One commit per READ, not per line — see `consumeFrames`.
      (chunks) => setProgress((seen) => [...seen, ...chunks]),
      (ending) => {
        setStreaming(false);
        if (ending === "unsupported") setSupported(false);
      },
    );
    return () => {
      stop();
      setStreaming(false);
    };
  }, [runId, namespace, startIndex, intervalMs, getClient]);

  return { progress, latest: progress.at(-1), streaming, supported };
}
