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
import { useEffect, useRef, useState } from "react";
import { sseFrames } from "./_sse.ts";
import { createWorkflowApi, type WorkflowApi } from "./workflow-client.ts";

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
 * Drain one bounded read's frames, reporting how it ended and how many chunks it
 * handed over.
 *
 * `skip` is how many leading chunks the reader has already been given, which is
 * non-zero only in the negative-`startIndex` case: a re-open there cannot name an
 * absolute position, so it re-reads the window from the beginning.
 */
async function consumeFrames<T>(
  body: ReadableStream<Uint8Array>,
  skip: number,
  signal: AbortSignal,
  onChunk: (chunk: T) => void,
): Promise<{ ending: Ending; taken: number }> {
  let remaining = skip;
  let taken = 0;
  let ending: Ending = "partial";
  for await (const frame of sseFrames(body, signal)) {
    if (frame.event === "chunk") {
      if (remaining > 0) remaining -= 1;
      else {
        taken += 1;
        onChunk(frame.data as T);
      }
    } else if (frame.event === "done") {
      // `complete` on the `done` frame is the RUN's state, not the read's: a
      // bounded read always ends, and only this says whether to come back.
      ending = (frame.data as { complete?: boolean } | undefined)?.complete
        ? "complete"
        : "partial";
    } else if (frame.event === "missing") {
      // The id will never exist, so there is nothing to come back for.
      return { ending: "complete", taken };
    }
  }
  return { ending, taken };
}

/**
 * Read one run's progress until it is complete, reporting each chunk.
 *
 * Module-level rather than inline in the hook, so the loop reads without React in
 * the way — the same split `useWorkflowRun` makes with `pollUntilTerminal`.
 *
 * Every re-open asks from `startIndex + seen`, so a read only ever fetches chunks
 * this reader has not already been given. That is what keeps the poll cheap: a
 * quiet run answers with a bare `done` rather than the whole log again.
 */
function readProgressUntilComplete<T>(
  getClient: () => RunProgressReader,
  runId: string,
  options: { namespace?: string | undefined; startIndex?: number | undefined },
  intervalMs: number,
  onChunk: (chunk: T) => void,
  onEnded: (ending: Ending) => void,
): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Chunks handed to the caller, which is also the offset the next read resumes
  // from. A negative `startIndex` ("the last N") is only meaningful on the FIRST
  // read; after that this reader holds an absolute position and uses it.
  let seen = 0;

  const resumeFrom = (): number | undefined => {
    if (seen === 0) return options.startIndex;
    const base = options.startIndex ?? 0;
    // A negative start has no absolute successor to resume from, so a re-open
    // asks for everything and the dedupe below drops what was already seen.
    return base < 0 ? undefined : base + seen;
  };

  /** One bounded read. */
  const readOnce = async (): Promise<Ending> => {
    const from = resumeFrom();
    // `omitUndefined` rather than a spread: under `exactOptionalPropertyTypes` a
    // present-and-undefined `namespace` is not the same as an absent one, and the
    // client would put an empty parameter on the query string.
    const res = await getClient().streamOutput(runId, {
      ...omitUndefined({ namespace: options.namespace, startIndex: from }),
      signal: controller.signal,
    });
    // A non-2xx, or a body-less response, is an agent that does not serve this —
    // the ordinary case for one deployed before the route existed, and also what
    // a 404 for an unknown run looks like.
    if (!(res.ok && res.body)) return "unsupported";
    const skip = from === undefined ? seen : 0;
    const { ending, taken } = await consumeFrames<T>(res.body, skip, controller.signal, onChunk);
    seen += taken;
    return ending;
  };

  const tick = async (): Promise<void> => {
    let ending: Ending;
    try {
      ending = await readOnce();
    } catch {
      // A thrown fetch is a transport failure, not an absent route — and not a
      // reason to stop watching a live run, so it is retried like a `partial`.
      ending = "partial";
    }
    if (controller.signal.aborted) return;
    if (ending !== "partial") {
      onEnded(ending);
      return;
    }
    // Re-armed from the SETTLED read rather than on an interval, so a slow
    // response cannot stack overlapping reads.
    timer = setTimeout(() => void tick(), intervalMs);
  };
  void tick();

  return () => {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
  };
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

  /**
   * The caller's client, held in a ref rather than named as an effect
   * dependency — the same footgun `useWorkflowRun` documents at length: the
   * natural spelling passes a new object every render, which as a dependency is
   * an unbounded stream-reopen loop against the agent.
   */
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    // A new id must not show the previous run's lines for a frame.
    setProgress([]);
    setSupported(true);
    setStreaming(false);
    if (!runId) return;
    setStreaming(true);
    // Built lazily and ONCE per watch — as a render-time default it would be a
    // fresh object per render, the same hazard the ref above exists for.
    let fallback: WorkflowApi | undefined;
    const getClient = (): WorkflowApi => {
      const current = apiRef.current;
      if (current) return current;
      fallback ??= createWorkflowApi();
      return fallback;
    };
    const stop = readProgressUntilComplete<T>(
      getClient,
      runId,
      { namespace, startIndex },
      intervalMs,
      (chunk) => setProgress((seen) => [...seen, chunk]),
      (ending) => {
        setStreaming(false);
        if (ending === "unsupported") setSupported(false);
      },
    );
    return () => {
      stop();
      setStreaming(false);
    };
  }, [runId, namespace, startIndex, intervalMs]);

  return { progress, latest: progress.at(-1), streaming, supported };
}
