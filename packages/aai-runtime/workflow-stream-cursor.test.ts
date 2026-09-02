// Copyright 2026 the AAI authors. MIT license.
/**
 * The progress cursor's DEFINING property, over write logs and polling schedules
 * nobody wrote by hand.
 *
 * > For any write log and any polling schedule, concatenating successive reads
 * > driven by the cursor the previous read returned reproduces the log exactly
 * > once — no gap, no duplicate.
 *
 * One cursor has SIX implementations — the memory store's `read`, the SSE
 * route's `budgetFor`, the SDK client's query encoding, the SDK's
 * `followRunOutput`, `useWorkflowProgress`, and the eval adapter's `fromIndex` —
 * and every existing spec on the path asserts about ONE of them with a fake
 * standing in for the others. That is how a `startIndex` that was an EXCLUSIVE
 * floor in the store and an INCLUSIVE one in every consumer survived: the
 * store's own spec pinned exclusive, the client's spec pinned that a `0` really
 * is sent, the follow spec pinned the cursor arithmetic against a fake that
 * ignored the semantic entirely — and all three passed. The defect was that a
 * default `followRunOutput` never yielded chunk 0, a run's first progress line,
 * permanently; no assertion in the repository could see it, because none joined
 * two implementations end to end.
 *
 * So this asserts the SENTENCE rather than any of the six mechanisms, which is
 * what makes it an oracle rather than a seventh pin. Three properties:
 *
 * 1. **`read` answers exactly the chunks the cursor names**, cap included,
 *    against a model of the retained window computed in closed form.
 * 2. **The eval adapter answers what the memory store answers**, for every
 *    generated (log, cursor) pair — two implementations of one `WdkAdapter`
 *    method, so a fix applied to only one of them fails here.
 * 3. **A poll loop reconstructs the log exactly once**, twice over: the SDK's
 *    real `followRunOutput` driven through the real client and the real
 *    `budgetFor`, and `useWorkflowProgress`'s cursor arithmetic against the same
 *    route. This is the one that was red.
 *
 * ## Why this is a UNIT test
 *
 * The MODEL is the write array. Nothing here touches a clock, a socket or a
 * disk: the store is in memory, the route is `budgetFor` plus a slice, the
 * client's `fetch` is a stub answering out of that store, and
 * `followRunOutput`'s one-second re-open wait runs on virtual time. Same ~1s
 * budget as `workflow-resume-equivalence.test.ts`, whose house style this
 * follows — generate the whole world, and floor every state the properties
 * depend on having reached.
 *
 * ## `useWorkflowProgress` is REPRODUCED, and that is a boundary rather than a shortcut
 *
 * It is a React hook in `@alexkroman1/aai-ui`, a browser bundle this package may
 * not import (`konsistent.json`'s dependency-graph boundaries), and its loop is
 * module-private behind `repeatUntil`. So property 3's second half re-states its
 * two lines of cursor arithmetic — `next += chunks.length`, and a `next` of 0
 * sent as an ABSENT parameter — and asserts over the same route. If those lines
 * change, this copy changes with them; `use-workflow-progress.test.ts` pins the
 * hook's own end.
 */

import { workflow } from "@alexkroman1/aai";
import { report } from "@alexkroman1/aai/step";
import { createWorkflowApiClient } from "@alexkroman1/aai/workflow-api";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createEvalWorkflowEngine, type EvalWorkflowEngine } from "./eval/workflow-engine.ts";
import { budgetFor } from "./workflow-api-stream.ts";
import {
  createMemoryStreams,
  DEFAULT_STREAM_NAMESPACE,
  STREAM_CAP,
  STREAM_SLACK,
  type StreamRead,
  type StreamStore,
} from "./workflow-streams.ts";

/** The run every property writes to. One is enough — the cursor is per channel. */
const RUN = "wrun_oracle";

/**
 * States the generated corpus has to have REACHED, or the properties are
 * satisfied by logs and schedules that never exercised a cursor.
 *
 * Floors are set under the OBSERVED MINIMUM over 20 runs, with the range beside
 * each — never a fraction of the mean. What one generated schedule reaches is
 * correlated within a run rather than independent per poll, so these
 * distributions have long left tails.
 */
const reached = {
  /** Reads issued with a NON-NEGATIVE cursor — the reading that was wrong. */
  absoluteCursors: 0,
  /** Reads issued with a negative cursor, which counts back from the end. */
  negativeCursors: 0,
  /** Cursors past the tail, which name nothing. */
  pastTail: 0,
  /** Logs long enough that the cap really dropped chunks off the front. */
  capDrops: 0,
  /** Cursors BELOW the first retained index — a cursor from before a drop. */
  staleCursors: 0,
  /** Polls that were not the first, i.e. re-opens driven by a returned cursor. */
  reopens: 0,
  /** Re-opens that really had new chunks to hand over. */
  reopensWithChunks: 0,
  /** Reads a caller issued from a non-zero starting position. */
  offsetStarts: 0,
};

/**
 * How many chunks a channel still holds after `total` writes, in CLOSED FORM.
 *
 * The store drops in blocks: it splices back to {@link STREAM_CAP} the moment a
 * write takes it past `CAP + SLACK`. Written as arithmetic on `total` rather than
 * by replaying that loop, because a model that replays the implementation agrees
 * with the implementation's bugs.
 */
function retainedAfter(total: number): number {
  const ceiling = STREAM_CAP + STREAM_SLACK;
  if (total <= ceiling) return total;
  return STREAM_CAP + ((total - ceiling - 1) % (STREAM_SLACK + 1));
}

/** The absolute indices a channel holds after `total` writes, oldest first. */
function heldIndices(total: number): number[] {
  const retained = retainedAfter(total);
  const first = total - retained;
  return Array.from({ length: retained }, (_unused, offset) => first + offset);
}

/**
 * The indices `startIndex` names, as the CANONICAL semantic defines them.
 *
 * A non-negative cursor is an INCLUSIVE floor — "start at this index" — which is
 * what the published `StreamOptions.startIndex` doc promises, what `fromIndex` is
 * named for, and the only reading under which a reader that has seen nothing can
 * spell its own cursor. A negative one counts back from the end. Expressed as a
 * FILTER over the held indices, deliberately not the store's slice arithmetic.
 */
function modelIndices(total: number, startIndex: number | undefined): number[] {
  const held = heldIndices(total);
  if (startIndex === undefined) return held;
  if (startIndex < 0) return held.slice(Math.max(0, held.length + startIndex));
  return held.filter((index) => index >= startIndex);
}

/** A short log of distinguishable values. */
const shortLogArb = fc.array(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 12 });

/**
 * A write log, as a DESCRIPTOR rather than as the array.
 *
 * The capped arm needs over 1,100 chunks to reach a drop, and generating them —
 * or `.map`-ing a count into them inside the arbitrary — makes fast-check print
 * all 1,101 as the counterexample, which is the wall of a counterexample the
 * house style warns about: the run that found the cap off-by-one printed 1,101
 * strings and the reader had to count them to see which index was missing.
 * A descriptor prints `{ kind: "capped", total: 1101 }`, and the property
 * materializes it.
 */
type LogSpec = { kind: "explicit"; values: string[] } | { kind: "capped"; total: number };

const logArb: fc.Arbitrary<LogSpec> = fc.oneof(
  {
    arbitrary: shortLogArb.map((values): LogSpec => ({ kind: "explicit", values })),
    weight: 8,
  },
  {
    arbitrary: fc
      .integer({ min: STREAM_CAP + STREAM_SLACK + 1, max: STREAM_CAP + STREAM_SLACK + 250 })
      .map((total): LogSpec => ({ kind: "capped", total })),
    weight: 3,
  },
);

/** The log a spec describes. Values name their own index, so a gap is readable. */
function logOf(spec: LogSpec): string[] {
  if (spec.kind === "explicit") return spec.values;
  return Array.from({ length: spec.total }, (_unused, index) => `c${index}`);
}

/**
 * A cursor to read at, covering every reading the parameter has.
 *
 * Deliberately not clamped to the log: a cursor past the tail and a cursor from
 * before a cap drop are both legitimate — a poller holds the first whenever a run
 * goes quiet and the second whenever a run outran the cap — and both are where an
 * off-by-one hides.
 */
const cursorArb = fc.oneof(
  fc.constant(undefined),
  fc.integer({ min: 0, max: 14 }),
  fc.integer({ min: STREAM_CAP - 4, max: STREAM_CAP + STREAM_SLACK + 4 }),
  fc.integer({ min: -6, max: -1 }),
);

/** How many chunks the run writes before each poll. */
const scheduleArb = fc.array(fc.nat({ max: 3 }), { minLength: 1, maxLength: 8 });

/** A store holding exactly `log`, written one chunk at a time as a run does. */
async function storeOf(log: readonly string[]): Promise<StreamStore> {
  const streams = createMemoryStreams();
  for (const value of log) await streams.write(RUN, DEFAULT_STREAM_NAMESPACE, value);
  return streams;
}

/** `StreamRead` for a cursor, with an absent one really absent. */
function readOptions(startIndex: number | undefined): StreamRead {
  return startIndex === undefined ? {} : { startIndex };
}

/** What one read exercised, for the floors above. */
function noteCursor(total: number, cursor: number | undefined): void {
  const held = heldIndices(total);
  if (held.length < total) reached.capDrops++;
  if (cursor === undefined) return;
  if (cursor < 0) {
    reached.negativeCursors++;
    return;
  }
  reached.absoluteCursors++;
  if (cursor > (held.at(-1) ?? -1)) reached.pastTail++;
  if (cursor < (held[0] ?? 0)) reached.staleCursors++;
}

/**
 * What `GET /workflows/runs/:id/stream` emits for one read.
 *
 * The route's two halves, in its own order: the TAIL first (so a chunk written
 * between the two belongs to the reader's next read), then the budget that read
 * may spend, then the store's own window truncated to it. `budgetFor` is the real
 * function; the pipe loop it bounds is one `slice`, which is the whole of
 * `pipeChunksAsSse` once the socket is taken out.
 */
async function serveRoute(
  streams: StreamStore,
  startIndex: number | undefined,
): Promise<unknown[]> {
  const tail = await streams.tail(RUN, DEFAULT_STREAM_NAMESPACE);
  const budget = budgetFor(tail, startIndex);
  const chunks = await streams.read(RUN, readOptions(startIndex));
  return chunks.slice(0, budget).map((chunk) => chunk.value);
}

/** One poll's answer, plus where it sat in the schedule. */
type Poll = { values: unknown[]; complete: boolean; ordinal: number };

/**
 * A run writing on a schedule, and the route that serves it.
 *
 * Shared by both halves of property 3 so the two consumers are held against the
 * SAME world: the batch for poll k lands before poll k is served, and the poll
 * after the last batch is the one that reports the run terminal. A per-property
 * copy of this is how the two cursors would come to be measured against two
 * different servers.
 */
function scheduledRun(schedule: readonly number[]): {
  written: string[];
  poll(startIndex: number | undefined): Promise<Poll>;
} {
  const streams = createMemoryStreams();
  const written: string[] = [];
  let ordinal = 0;
  return {
    written,
    async poll(startIndex: number | undefined): Promise<Poll> {
      for (let i = 0; i < (schedule[ordinal] ?? 0); i += 1) {
        const value = `v${written.length}`;
        written.push(value);
        await streams.write(RUN, DEFAULT_STREAM_NAMESPACE, value);
      }
      const complete = ordinal >= schedule.length;
      const at = ordinal;
      ordinal += 1;
      return { values: await serveRoute(streams, startIndex), complete, ordinal: at };
    },
  };
}

/** One SSE frame, in the shape the route writes. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Everything a readable yields. */
async function drain(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const value of stream) out.push(value);
  return out;
}

describe("the progress cursor", () => {
  test("read answers exactly the chunks the cursor names, cap included", async () => {
    await fc.assert(
      fc.asyncProperty(logArb, cursorArb, async (spec, cursor) => {
        const log = logOf(spec);
        const streams = await storeOf(log);
        noteCursor(log.length, cursor);
        const chunks = await streams.read(RUN, readOptions(cursor));
        const expected = modelIndices(log.length, cursor);
        expect(
          chunks.map((chunk) => chunk.value),
          "the store handed back a different window than the cursor names",
        ).toEqual(expected.map((index) => log[index]));
        // The INDEX a chunk carries is what a caller persists as its next cursor,
        // so it has to be the absolute position rather than an offset into this
        // read — the property every re-open below rests on.
        expect(
          chunks.map((chunk) => chunk.index),
          "a chunk's index is not absolute",
        ).toEqual(expected);
        expect(await streams.tail(RUN, DEFAULT_STREAM_NAMESPACE)).toBe(log.length - 1);
      }),
      { numRuns: 120 },
    );

    // Ranges over 20 runs, floors under the observed MINIMUM. Without these the
    // equality above is satisfied by a corpus of empty logs read from index 0.
    expect(reached.absoluteCursors, "no read used a non-negative cursor").toBeGreaterThan(35); // 52-68
    expect(reached.negativeCursors, "no read counted back from the end").toBeGreaterThan(15); // 27-37
    expect(reached.pastTail, "no cursor named a chunk the run had not reached").toBeGreaterThan(15); // 27-45
    expect(reached.capDrops, "no generated log outran the cap").toBeGreaterThan(15); // 26-39
    // The `Math.max(0, …)` clamp's own state: a cursor the cap has invalidated.
    // It was reached 0 times in 2 of the first 20 runs at the capped arm's
    // original weight, which is why that weight is 3 — a floor that is sometimes
    // right by luck is a flake, and the remedy is a generator that reaches the
    // state rather than a floor that tolerates missing it.
    // 3-10 over 40 runs. Floored at `> 0` rather than under the minimum: the
    // recorded 6-10 was measured on too few runs and this counter has a long
    // left tail, so the floor tripped on `expected 3 to be greater than 3` in 1
    // run of 20 — a flake in the one tier that carries no `retry`. Its whole
    // range is small, so what it is worth flooring for is the state being
    // reached AT ALL, never how often.
    expect(reached.staleCursors, "no cursor survived a cap drop").toBeGreaterThan(0);
  });

  test("the eval adapter answers what the memory store answers, for every cursor", async () => {
    const lines = z.object({ lines: z.array(z.string()) });
    const narrate = workflow({
      input: lines,
      run: async (input: { lines: string[] }) => {
        for (const line of input.lines) await report(line);
      },
    });
    let engine: EvalWorkflowEngine | undefined;
    try {
      engine = createEvalWorkflowEngine({ workflows: { narrate }, env: {} });
      const active = engine;
      await fc.assert(
        fc.asyncProperty(shortLogArb, cursorArb, async (log, cursor) => {
          const streams = await storeOf(log);
          const runId = await active.adapter.start("narrate", [{ lines: [...log] }]);
          await active.record(runId)?.settled;
          const fromStore = (await streams.read(RUN, readOptions(cursor))).map(
            (chunk) => chunk.value,
          );
          const fromAdapter = await drain(active.adapter.readStream(runId, readOptions(cursor)));
          expect(
            fromAdapter,
            "the eval adapter and the memory store disagree about one cursor",
          ).toEqual(fromStore);
          expect(await active.adapter.streamTail(runId, {})).toBe(
            await streams.tail(RUN, DEFAULT_STREAM_NAMESPACE),
          );
        }),
        { numRuns: 40 },
      );
    } finally {
      await engine?.release();
    }
  });
});

describe("a poll loop over the progress cursor", () => {
  beforeEach(() => {
    // `followRunOutput` waits a second between re-opens. On the wall clock a
    // generated schedule of eight polls would cost eight seconds a run.
    vi.useFakeTimers();
    return () => void vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("followRunOutput reconstructs the log exactly once — no gap, no duplicate", async () => {
    await fc.assert(
      fc.asyncProperty(
        scheduleArb,
        fc.option(fc.integer({ min: 0, max: 4 }), { nil: undefined }),
        async (schedule, fromIndex) => {
          const run = scheduledRun(schedule);
          const fetchStub = vi.fn(async (input: unknown): Promise<Response> => {
            const raw = new URL(String(input)).searchParams.get("startIndex");
            const { values, complete, ordinal } = await run.poll(
              raw === null ? undefined : Number(raw),
            );
            if (ordinal > 0) reached.reopens += 1;
            if (ordinal > 0 && values.length > 0) reached.reopensWithChunks += 1;
            const body =
              values.map((value) => frame("chunk", value)).join("") +
              frame("done", { runId: RUN, complete });
            return new Response(body, {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            });
          });
          vi.stubGlobal("fetch", fetchStub);
          try {
            if (fromIndex !== undefined && fromIndex > 0) reached.offsetStarts += 1;
            const api = createWorkflowApiClient({ baseUrl: "https://agent.example/my-agent" });
            const collected: unknown[] = [];
            let settled = false;
            const finished = (async () => {
              for await (const chunk of api.followOutput(
                RUN,
                fromIndex === undefined ? {} : { fromIndex },
              )) {
                collected.push(chunk);
              }
            })().then(() => {
              settled = true;
            });
            // The re-open wait is a second of VIRTUAL time; the extra turns cover
            // the terminal poll and leave the loop nothing to wait for.
            for (let turn = 0; turn < schedule.length + 4 && !settled; turn += 1) {
              await vi.advanceTimersByTimeAsync(1000);
            }
            await finished;
            const floor = fromIndex ?? 0;
            expect(collected, "the polls did not reconstruct the log exactly once").toEqual(
              run.written.filter((_value, index) => index >= floor),
            );
          } finally {
            vi.unstubAllGlobals();
          }
        },
      ),
      { numRuns: 60 },
    );

    // Ranges over 20 runs. A schedule that delivered its whole log on the first
    // poll proves nothing about a cursor, and one that wrote nothing proves less
    // — the shrunk counterexample this property first produced was a single poll
    // over a one-chunk log, and the floor is what keeps the corpus from being
    // made of only that shape's harmless twin.
    expect(reached.reopens, "no poll was ever a re-open").toBeGreaterThan(150); // 231-275
    expect(
      reached.reopensWithChunks,
      "no re-open ever had a new chunk to hand over",
    ).toBeGreaterThan(70); // 105-152
    expect(reached.offsetStarts, "no reader resumed from a non-zero index").toBeGreaterThan(20); // 31-45
  });

  test("useWorkflowProgress's cursor reconstructs the log exactly once", async () => {
    await fc.assert(
      fc.asyncProperty(
        scheduleArb,
        fc.option(fc.integer({ min: 0, max: 4 }), { nil: undefined }),
        async (schedule, start) => {
          const run = scheduledRun(schedule);
          const collected: unknown[] = [];
          // The hook's two lines, restated — see the module doc for why a copy.
          let next = start ?? 0;
          for (let poll = 0; poll <= schedule.length; poll += 1) {
            const { values } = await run.poll(next === 0 ? undefined : next);
            collected.push(...values);
            next += values.length;
          }
          const floor = start ?? 0;
          expect(collected, "a re-open lost or repeated a chunk").toEqual(
            run.written.filter((_value, index) => index >= floor),
          );
        },
      ),
      { numRuns: 60 },
    );
  });
});
