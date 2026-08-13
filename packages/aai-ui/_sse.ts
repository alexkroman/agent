// Copyright 2026 the AAI authors. MIT license.
/**
 * The server-sent-event parser both workflow streams read through.
 *
 * Split out when the second stream arrived: `workflow-events.ts` watches a run's
 * STATE and `use-workflow-progress.ts` reads what the run WROTE, and they parse
 * the identical wire format. A second copy of a stream parser is the kind of
 * duplication that goes wrong quietly — the two would drift on exactly the edges
 * documented below, and the symptom is a page that silently stops updating.
 *
 * @internal
 */

import { safeJsonParse } from "@alexkroman1/aai/utils";
import { createParser } from "eventsource-parser";

/** One parsed SSE frame. Comment frames (heartbeats) are skipped, not yielded. */
export type SseFrame = { event: string; data: unknown };

/**
 * Parse an SSE byte stream into frames, with `eventsource-parser`.
 *
 * The parser is `aai-studio-client`'s already (`src/api-events.ts`), and it is
 * catalogued — plus a transitive dependency of `@ai-sdk/provider-utils`, so it
 * is in this package's tree either way. Adopting it retired a hand-rolled line
 * splitter justified on the subset in use being "small and fixed" — true of our
 * own server, and not of what sits between it and the page:
 *
 * - It split on `"\n\n"` only. The spec permits `\n`, `\r\n` and `\r`, and a
 *   CRLF stream is `\r\n\r\n` — no two adjacent `\n`, so **not one frame ever
 *   parsed** and `pump` fell through to `"fallback"` on the clean end. Silently
 *   dropping to the poll is the exact cost the run-watch stream exists to avoid,
 *   and an intermediary re-terminating lines is not our choice to make.
 * - `line.startsWith("event: ")` required the space the spec makes optional.
 * - It kept only the LAST `data:` line rather than joining a multi-line one.
 *
 * Those three are what `workflow-events.test.ts` pins, and they are the three
 * that DISCRIMINATE — checked by running the specs against the old parser.
 * Comment frames and a leading BOM were already fine and are not credited here:
 * a heartbeat has no `event:` line, so the old parser dropped it anyway, and
 * `TextDecoder` strips the BOM before either parser sees a byte.
 *
 * Three properties of the parser this leans on. `feed` invokes `onEvent`
 * SYNCHRONOUSLY for every complete event in the chunk, so a batch is collected
 * per read and yielded in arrival order — the generator shape, and therefore
 * every caller, is unchanged. An event with no `data:` line at all is not
 * dispatched (also per spec); every frame these routes emit carries one, since
 * `workflow-api-events.ts` and `workflow-api-stream.ts` write `event:` and
 * `data:` together. And a chunk ending in a lone `\r` holds that byte back,
 * because it may yet turn out to be the first half of a `\r\n` — so a CR-ONLY
 * stream chunked per frame dispatches one frame behind, and its last frame not
 * at all (it would need `reset({ consume: true })`, which would also consume a
 * genuinely truncated frame as if it were whole). Nothing emits CR-only endings,
 * and the outcome if anything did is the safe one for both readers: a stream
 * that ends with no final frame is read as a dropped connection, which the run
 * watch answers by falling back to the poll and the progress reader by
 * re-opening.
 */
export async function* sseFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let batch: SseFrame[] = [];
  const parser = createParser({
    onEvent: ({ event, data }) => {
      // An unnamed event cannot be classified by either caller, and these routes
      // name every frame they send.
      if (event === undefined) return;
      // `safeJsonParse` rather than a local try/catch: an unparseable frame is
      // not a reason to tear the stream down (a run-watch frame carries a WHOLE
      // snapshot, so the next one restates the same state, and a progress read
      // is re-opened), and the SDK already owns that decision.
      batch.push({ event, data: safeJsonParse(data) });
    },
  });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      parser.feed(decoder.decode(value, { stream: true }));
      if (batch.length === 0) continue;
      const frames = batch;
      batch = [];
      // An explicit loop, not `yield*`: async delegation awaits the array's
      // iterator per element, which adds turns of the microtask queue for no
      // reason and puts the frame count into this module's timing.
      for (const frame of frames) yield frame;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
