// Copyright 2026 the AAI authors. MIT license.
/**
 * Watching a run over server-sent events — the PUSH half of `useWorkflowRun`.
 *
 * Its own module because the seam is clean: everything in `workflow-client.ts`
 * is request/response shaping plus the poll, and this is one long-lived stream
 * and the SSE parser it needs.
 *
 * @internal
 */

import { safeJsonParse } from "@alexkroman1/aai/utils";
import type { WorkflowApi, WorkflowRun } from "./workflow-client.ts";

/**
 * The slice of the client this needs: one method.
 *
 * Narrowed rather than taking the whole `WorkflowApi`, and the narrowing is the
 * honest statement — nothing here reads a run, starts one, or cancels one, it
 * opens ONE stream. It also makes a test double a plain object rather than a
 * six-method stub cast into shape. A real client satisfies it structurally.
 */
export type RunWatcher = Pick<WorkflowApi, "watch">;

/**
 * Watch a run over SSE, falling back to the caller's poll on any failure.
 *
 * The poll stays the fallback rather than being replaced, and that is the whole
 * shape of this: a stream is an optimisation over a mechanism that already
 * works, so every way it can fail — an older agent with no `/events` route, a
 * proxy that buffers, a network that drops it — has to degrade to the thing that
 * does. What it buys is real, though: on the platform every polled read BROKERS,
 * so N open tabs at `DEFAULT_WORKFLOW_POLL_MS` is N/2 brokered requests a
 * second, each able to boot a sandbox. One stream per tab replaces all of it.
 *
 * `EventSource` is not used, for two reasons that both matter here: it cannot
 * send an `Authorization` header (an agent with `AAI_WORKFLOW_API_TOKEN` set
 * would be unreachable), and it reconnects on its own schedule, which would
 * fight the caller's. A `fetch` stream gives both back.
 *
 * Returns a stop function. `onFallback` is called at most once, when this stream
 * cannot be relied on and the poll should take over.
 */
export function watchRunEvents<R>(
  getClient: () => RunWatcher,
  runId: string,
  onRun: (run: WorkflowRun<R>) => void,
  onSettled: () => void,
  onFallback: () => void,
): () => void {
  const controller = new AbortController();
  let handedOver = false;
  const handOver = (): void => {
    if (handedOver || controller.signal.aborted) return;
    handedOver = true;
    onFallback();
  };

  /**
   * Consume the stream. Resolves `"settled"` when the run reached a state
   * nothing will change, and `"fallback"` for every other ending — including a
   * clean end with no final frame, which is a dropped connection.
   *
   * A named function rather than an inline IIFE so `watchRunEvents` stays under
   * the cognitive-complexity cap, and so the two outcomes are a return value
   * instead of two callbacks invoked from six places.
   */
  const pump = async (): Promise<"settled" | "fallback"> => {
    const res = await getClient().watch(runId, controller.signal);
    // A non-2xx, or a body-less response, is an agent that does not serve this —
    // the ordinary case for one deployed before the route existed.
    if (!(res.ok && res.body)) return "fallback";
    for await (const frame of sseFrames(res.body, controller.signal)) {
      if (frame.event === "run" && frame.data) onRun(frame.data as WorkflowRun<R>);
      const outcome = endingFor(frame.event);
      if (outcome) return outcome;
    }
    return "fallback";
  };

  void pump().then(
    (outcome) => (outcome === "settled" ? onSettled() : handOver()),
    () => handOver(),
  );

  return () => controller.abort();
}

/**
 * Does this frame END the stream, and does the run need watching afterwards?
 *
 * `done` and `missing` are both final and neither wants a reconnect: the run is
 * terminal, or the id will never exist (a 404 is a stable answer — the world's
 * record is durable). `idle` is the stream handing ITSELF back after its
 * duration cap, so that one falls back to the poll. Anything else is not an
 * ending.
 */
function endingFor(event: string): "settled" | "fallback" | undefined {
  if (event === "done" || event === "missing") return "settled";
  return event === "idle" ? "fallback" : undefined;
}

/** One parsed SSE frame. Comment frames (heartbeats) are skipped, not yielded. */
type SseFrame = { event: string; data: unknown };

/**
 * Parse an SSE byte stream into frames.
 *
 * Hand-rolled rather than pulled in, because the subset in use is small and
 * fixed (`event:` + one `data:` line, blank-line terminated) and the failure
 * mode of a parser that is too clever here is a page that silently stops
 * updating. It buffers across chunk boundaries, which is the one thing a naive
 * split gets wrong: a frame is not guaranteed to arrive whole.
 */
async function* sseFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const frame = parseFrame(raw);
        if (frame) yield frame;
        split = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

function parseFrame(raw: string): SseFrame | undefined {
  let event: string | undefined;
  let data: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("data: ")) data = line.slice(6);
  }
  if (event === undefined) return;
  // `safeJsonParse` rather than a local try/catch: an unparseable frame is not a
  // reason to tear the stream down (every frame carries a WHOLE snapshot, so the
  // next one restates the same state), and the SDK already owns that decision.
  return { event, data: data === undefined ? undefined : safeJsonParse(data) };
}
