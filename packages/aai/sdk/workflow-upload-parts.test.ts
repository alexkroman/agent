// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the PARALLEL upload path.
 *
 * What is asserted here is what the fan-out promises and nothing the ordinary
 * writer already covers: that the file is cut where the store can accept it, that
 * the parts really overlap, that every reason to decline sends the file the plain
 * way instead, and that a bar drawn over four connections describes the FILE.
 *
 * Driven against a scripted `fetch` rather than a server, because every one of
 * those is a property of the requests this issues — the server's half is pinned in
 * `host/workflow-api-uploads.test.ts` against a real router.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  client,
  json,
  PART,
  record,
  recording,
  scriptAgent,
  settle,
  TOTAL,
  withoutBackoff,
} from "./_upload-parts-test-utils.ts";
import {
  UPLOAD_CHUNK_BYTES,
  UPLOAD_PART_ATTEMPTS,
  UPLOAD_PART_CONCURRENCY,
  UPLOAD_RESUME_ATTEMPTS,
  UPLOAD_RETRY_BASE_MS,
} from "./constants.ts";
import type { UploadProgress } from "./workflow-upload-client.ts";
import { partsPlan, planParts } from "./workflow-upload-parts.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  scriptAgent();
});

describe("sending a file as parts", () => {
  test("declares the total, then fills it in windows the store can accept", async () => {
    const agent = scriptAgent();
    const stored = await client().upload(recording(), { name: "call.wav", parallel: true });

    const [begun] = agent.calls;
    expect(begun?.method).toBe("POST");
    expect(begun?.url.pathname).toMatch(/\/uploads\/[a-z0-9]+\/parts$/);
    expect(begun?.url.searchParams.get("total")).toBe(String(TOTAL));
    expect(begun?.url.searchParams.get("name")).toBe("call.wav");

    // Every offset a whole number of chunks, which is the store's one rule, and
    // every part the same size but the last.
    const offsets = agent.parts.map((one) => Number(one.url.searchParams.get("offset")));
    expect(offsets.toSorted((a, b) => a - b)).toEqual([0, PART, PART * 2]);
    expect(offsets.every((at) => at % UPLOAD_CHUNK_BYTES === 0)).toBe(true);
    expect(agent.parts.map((one) => one.bytes)).toEqual([PART, PART, PART]);
    // The record is the AGENT's, read back rather than assembled here: `complete`
    // is its claim about whether every byte landed.
    expect(stored).toMatchObject({ id: "abc", size: TOTAL, complete: true });
  });

  test("really overlaps them, which is the whole reason this path exists", async () => {
    const agent = scriptAgent();
    // TWICE the width in parts, derived — the pool has to cycle for the peak to mean
    // anything, and a file of exactly `concurrency` parts would report a peak equal
    // to the width whether the pool bounded it or ran everything at once. Both
    // numbers were literals (`8` parts, peak `4`) until the default width moved.
    const parts = UPLOAD_PART_CONCURRENCY * 2;
    await client().upload(recording(PART * parts), { parallel: true });
    expect(agent.parts).toHaveLength(parts);
    expect(agent.peak).toBe(UPLOAD_PART_CONCURRENCY);
  });

  test("honours a caller's own concurrency", async () => {
    const agent = scriptAgent();
    await client().upload(recording(PART * 8), { parallel: { concurrency: 2 } });
    expect(agent.peak).toBe(2);
  });

  test("cuts on the caller's part size, rounded up to a whole chunk", async () => {
    const agent = scriptAgent();
    // A part size the store could not accept as given: rounding it up is what
    // makes `partBytes` a preference rather than a way to fail.
    await client().upload(recording(UPLOAD_CHUNK_BYTES * 4), {
      parallel: { partBytes: UPLOAD_CHUNK_BYTES + 1 },
    });
    expect(agent.parts.map((one) => Number(one.url.searchParams.get("offset")))).toHaveLength(2);
    expect(agent.parts.every((one) => one.bytes === UPLOAD_CHUNK_BYTES * 2)).toBe(true);
  });

  test("sends the LAST part short rather than padding the file", async () => {
    const agent = scriptAgent();
    await client().upload(recording(PART + 3), { parallel: true });
    expect(agent.parts.map((one) => one.bytes).toSorted((a, b) => a - b)).toEqual([3, PART]);
  });

  test("uploadStream fills in the CALLER's id, so a run can start on it first", async () => {
    const agent = scriptAgent();
    await client().uploadStream("chosen-id", recording(), { parallel: true });
    // The whole difference from `upload`: the id was decided before the bytes, so
    // it is already in a run input somewhere.
    expect(agent.calls.every((one) => one.url.pathname.includes("/uploads/chosen-id"))).toBe(true);
  });
});

describe("declining, rather than failing", () => {
  test("a file that fits in one part is not worth two extra round trips", async () => {
    const agent = scriptAgent();
    await client().upload(recording(UPLOAD_CHUNK_BYTES), { parallel: true });
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]?.url.pathname).toMatch(/\/uploads$/);
  });

  test("a string body is sent whole, because it cannot be cut by BYTE", async () => {
    const agent = scriptAgent();
    // Its length is its UTF-8 encoding's, so cutting it by character would put a
    // part boundary inside a code point.
    await client().upload("a".repeat(TOTAL), { name: "a.txt", parallel: true });
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]?.url.pathname).toMatch(/\/uploads$/);
  });

  test("`parallel: false` opts OUT, and is the only way to", async () => {
    const agent = scriptAgent();
    await client().upload(recording(), { parallel: false });
    expect(agent.calls).toHaveLength(1);
  });
});

describe("a CALLER-NAMED upload is cut so it can be resumed", () => {
  /** A recording well under one part — the ordinary size of one off a phone. */
  const SMALL = UPLOAD_CHUNK_BYTES * 4;
  const small = () => recording(SMALL);

  test("into chunk-sized windows, because a part is ALL-OR-NOTHING", async () => {
    const agent = scriptAgent();
    await client().uploadStream("abc", small());
    // `upload` sends this file in one request and is right to — there the path only
    // buys speed and one window has nothing to overlap. Here it buys resumability,
    // and one window of the whole file is a resume that re-sends the whole file.
    expect(agent.parts.map((one) => Number(one.url.searchParams.get("offset")))).toEqual([
      0,
      UPLOAD_CHUNK_BYTES,
      UPLOAD_CHUNK_BYTES * 2,
      UPLOAD_CHUNK_BYTES * 3,
    ]);
  });

  test("so a PAUSE at 90% resumes rather than starting over", async () => {
    // What shipped: the file fit in one part, so this went as a single `PUT` — a
    // shape with nothing to resume, because a second `PUT` to a chosen id is the
    // 409 that makes choosing one safe. So resuming sent the whole recording again
    // from byte zero and was THEN refused as a taken id.
    const agent = scriptAgent({
      begin: 409,
      landed: [{ start: 0, end: UPLOAD_CHUNK_BYTES * 3 }],
    });
    const stored = await client().uploadStream("abc", small(), { resume: true });
    expect(agent.parts.map((one) => Number(one.url.searchParams.get("offset")))).toEqual([
      UPLOAD_CHUNK_BYTES * 3,
    ]);
    expect(stored.complete).toBe(true);
  });

  test("and an EMPTY file is still declined, having nothing to resume", async () => {
    const agent = scriptAgent();
    await client().uploadStream("abc", recording(0));
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]?.method).toBe("PUT");
  });

  test("`parallel: false` still opts out — and out of resuming with it", async () => {
    const agent = scriptAgent();
    await client().uploadStream("abc", small(), { parallel: false });
    expect(agent.calls).toHaveLength(1);
  });
});

describe("the default", () => {
  test("cuts the file up without being asked to", async () => {
    const agent = scriptAgent();
    // No `parallel` at all. It was opt-in, and what that left as the default was
    // the path that is both slower and unretryable — one connection, and one
    // dropped response costing the whole file.
    const stored = await client().upload(recording(), { name: "call.wav" });
    expect(agent.parts).toHaveLength(3);
    expect(stored).toMatchObject({ size: TOTAL, complete: true });
  });

  test("still declines a file it cannot help", async () => {
    const agent = scriptAgent();
    // The reasons to decline are properties of the FILE, so the default costs
    // nothing where it would not have paid: one request, and no claim in front
    // of it.
    await client().upload(recording(PART / 2));
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]?.method).toBe("POST");
    expect(agent.calls[0]?.url.pathname).toMatch(/\/uploads$/);
  });
});

describe("a part that does not land", () => {
  test("is sent again, because a dropped connection is the ordinary failure here", async () => {
    const agent = scriptAgent({ refuse: { offset: PART, network: true } });
    const stored = await client().upload(recording(), { parallel: true });
    // Four requests for three parts: the retried window went twice, and the store
    // takes the repeat as the same part rather than as a second one.
    expect(agent.parts).toHaveLength(4);
    expect(
      agent.parts.filter((one) => one.url.searchParams.get("offset") === String(PART)),
    ).toHaveLength(2);
    expect(stored.complete).toBe(true);
  });

  test("is NOT sent again when the agent refused it", async () => {
    const agent = scriptAgent({ refuse: { offset: PART, status: 400 } });
    // A 400 will be answered identically every time, so retrying it is a loop the
    // caller pays for twice before hearing the same thing.
    await expect(client().upload(recording(), { parallel: true })).rejects.toThrow(/refused/);
    expect(
      agent.parts.filter((one) => one.url.searchParams.get("offset") === String(PART)),
    ).toHaveLength(1);
  });

  test("is sent again when the platform said COME BACK, not no", async () => {
    // A 503 is the platform's own word for retryable — a sandbox booting, draining
    // or a forward that gave up — and reading it as a refusal ended the whole
    // fan-out over one part. In production that froze the stored prefix at the
    // parts that had landed and the run watching the upload failed five minutes
    // later with `the uploader stopped`.
    const agent = scriptAgent({ refuse: { offset: PART, status: 503 } });
    const stored = await client().upload(recording(), { parallel: true });
    expect(
      agent.parts.filter((one) => one.url.searchParams.get("offset") === String(PART)),
    ).toHaveLength(2);
    expect(stored.complete).toBe(true);
  });

  test("gives up on the retry budget, so a 503 is not a loop either", async () => {
    const agent = scriptAgent({ refuse: { offset: PART, status: 503, always: true } });
    await expect(
      withoutBackoff(() => client().upload(recording(), { parallel: true })),
    ).rejects.toThrow(/refused/);
    // The whole budget and no more — and the agent's own answer is what the caller
    // hears, not an invented one. The two budgets COMPOSE, deliberately: the
    // request one waits out a busy guest and the resume one waits out a guest that
    // is not there, so an agent refusing forever is asked
    // `UPLOAD_PART_ATTEMPTS` times per round for `UPLOAD_RESUME_ATTEMPTS` rounds
    // and then told about it.
    expect(
      agent.parts.filter((one) => one.url.searchParams.get("offset") === String(PART)),
    ).toHaveLength(UPLOAD_PART_ATTEMPTS * UPLOAD_RESUME_ATTEMPTS);
  });

  test("an agent that goes away mid-fan-out and comes back keeps the file", async () => {
    // The whole point of the resume loop, from the outside. The first round loses
    // one window's entire request budget — which is what a redeploy looks like to
    // a part — and the store answers the second round's claim with the 409 that
    // says the id is already ours.
    const agent = scriptAgent({
      refuse: { offset: PART, status: 503, times: UPLOAD_PART_ATTEMPTS },
      begin: [201, 409],
      landed: [{ start: 0, end: PART }],
    });
    const stored = await withoutBackoff(() => client().upload(recording(), { parallel: true }));

    expect(stored.complete).toBe(true);
    // TWO claims, the second under the SAME id: a fresh id would be a second
    // upload holding only the tail of the file.
    const claims = agent.calls.filter(
      (one) => one.method === "POST" && one.url.pathname.endsWith("/parts"),
    );
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((one) => one.url.pathname)).size).toBe(1);
    // And the second round sends only what is MISSING. Re-sending the file would
    // also work and is exactly what this exists not to do: `landed` covers every
    // window below `PART`, so each of those is sent ONCE across both rounds.
    const below = agent.parts
      .map((one) => Number(one.url.searchParams.get("offset")))
      .filter((offset) => offset < PART);
    expect(new Set(below).size).toBe(below.length);
    expect(below.length).toBeGreaterThan(0);
  });

  test("WAITS before asking again, rather than re-colliding with the limit", async () => {
    vi.useFakeTimers();
    try {
      const agent = scriptAgent({ refuse: { offset: PART, status: 503, always: true } });
      // Abandoned at the end rather than left running: this upload never finishes,
      // and an in-flight one outlives the test that started it — issuing its
      // remaining parts against whatever `fetch` the NEXT spec has stubbed.
      const abandon = new AbortController();
      const stored = client().upload(recording(), { parallel: true, signal: abandon.signal });
      stored.catch(() => undefined);
      // Everything that can happen without the clock moving has happened: the part
      // was refused, and the re-send has NOT gone out. That is the whole fix — a
      // fan-out hits a capacity limit together, so an immediate re-send is four
      // connections asking again in unison inside the window they are waiting out.
      await vi.advanceTimersByTimeAsync(0);
      const sent = (): number =>
        agent.parts.filter((one) => one.url.searchParams.get("offset") === String(PART)).length;
      expect(sent()).toBe(1);

      // Still nothing a fifth of a window later — jitter draws from the window's
      // upper half, so this is the bound a spec can state without pinning the draw
      // or the instant the timer was armed at.
      await vi.advanceTimersByTimeAsync(UPLOAD_RETRY_BASE_MS / 5);
      expect(sent()).toBe(1);
      // A whole window past that covers the first wait and cannot reach the SECOND,
      // whose own window is twice as wide — so this pins one re-send rather than
      // draining the budget.
      await vi.advanceTimersByTimeAsync(UPLOAD_RETRY_BASE_MS);
      expect(sent()).toBe(2);
      await settle(abandon, stored);
    } finally {
      vi.useRealTimers();
    }
  });

  test("waits as long as the agent ASKED, when it said", async () => {
    vi.useFakeTimers();
    try {
      const agent = scriptAgent({
        refuse: { offset: PART, status: 503, always: true, retryAfter: "5" },
      });
      const abandon = new AbortController();
      const stored = client().upload(recording(), { parallel: true, signal: abandon.signal });
      stored.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      const sent = (): number =>
        agent.parts.filter((one) => one.url.searchParams.get("offset") === String(PART)).length;

      // The far side knows something the backoff does not — that is what makes a
      // burst DRAIN instead of re-colliding — so its own number beats the schedule.
      // Three seconds is six times the longest wait the schedule alone can produce
      // for a first retry, so nothing but the header can explain the silence.
      await vi.advanceTimersByTimeAsync(3000);
      expect(sent()).toBe(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(sent()).toBe(2);
      await settle(abandon, stored);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stops the parts still in flight when one of them fails", async () => {
    // Held, so they are still on the wire when their sibling is refused — a part the
    // fake answers has already finished and has nothing left to abandon.
    const agent = scriptAgent({
      refuse: { offset: PART, status: 400 },
      hold: [0, PART * 2],
    });
    await expect(client().upload(recording(), { parallel: true })).rejects.toThrow(/refused/);
    // Both of them, rather than two connections going on uploading into an upload
    // whose answer is already decided — on a link the person is waiting on, and
    // against a store that has to write every byte of it.
    expect(agent.aborted.sort((a, b) => a - b)).toEqual([0, PART * 2]);
  });

  test("the CLAIM is sent again too, since losing it wastes the whole upload", async () => {
    // It was a bare `fetch` with no retry at all, and it brackets the fan-out: a
    // dropped response here means no file moves.
    const agent = scriptAgent({ begin: [503, 201] });
    const stored = await withoutBackoff(() => client().upload(recording(), { parallel: true }));
    expect(agent.calls.filter((one) => one.method === "POST")).toHaveLength(2);
    expect(stored.complete).toBe(true);
  });

  test("reads a 409 on a RETRIED claim as its own earlier one", async () => {
    // The id was minted for this upload, so nothing else can have taken it — the
    // claim we retried is the one that took it, and its answer was lost coming
    // back. Failing here would throw away a whole file for a dropped response.
    // `landed: []` is what the store really answers there: the claim landed, and
    // not one byte has. So the file goes up in full, and the only thing the 409
    // changed is that it was not treated as somebody else's id.
    const agent = scriptAgent({ begin: [503, 409], landed: [] });
    const stored = await withoutBackoff(() => client().upload(recording(), { parallel: true }));
    expect(agent.parts).toHaveLength(3);
    expect(stored.complete).toBe(true);
  });

  test("but a 409 on the FIRST claim is what it sounds like", async () => {
    // The store refusing a second upload into an id that is already somebody's is
    // exactly what makes a caller-chosen id safe, and no retry happened to explain
    // it away.
    const agent = scriptAgent({ begin: 409 });
    await expect(client().upload(recording(), { parallel: true })).rejects.toThrow();
    expect(agent.parts).toHaveLength(0);
  });

  test("the closing record is read again, since every byte is already stored", async () => {
    const agent = scriptAgent({ info: [503, 200] });
    const stored = await withoutBackoff(() => client().upload(recording(), { parallel: true }));
    expect(agent.calls.filter((one) => one.url.pathname.endsWith("/info"))).toHaveLength(2);
    expect(stored.complete).toBe(true);
  });

  test("REFUSES to report success over a record the agent never completed", async () => {
    // The silent half of a production failure. Every window was sent and every
    // acknowledgement came back 200, and the store had measured each as zero bytes —
    // so this read, whose whole purpose is the agent's own `complete`, answered
    // `size: 0, complete: false` and the client returned it as a stored file. The
    // caller then started a run over an upload nothing could read: the transcription
    // desk's header probe came back empty and reported "That is not a WAV file".
    const agent = scriptAgent({ direct: true, neverRecorded: true });
    await expect(
      withoutBackoff(() => client().upload(recording(), { parallel: true })),
    ).rejects.toThrow(/stored every part but reports 0 of \d+ byte\(s\)/);
    // It got that far honestly — the bytes really were all sent, which is why the
    // failure has to come from the RECORD rather than from any request failing.
    expect(agent.bytes).toHaveLength(TOTAL / PART);
  });

  test("a RESUMED upload sends only the windows the store does not have", async () => {
    // The claim is refused because the id is already this upload's own — which is
    // what `resume` says, and what the store answers 409 to for everybody else.
    const agent = scriptAgent({ begin: 409, landed: [{ start: 0, end: PART }] });
    const seen: UploadProgress[] = [];
    const stored = await client().uploadStream("abc", recording(), {
      resume: true,
      onProgress: (progress) => seen.push(progress),
    });
    // The first window is already stored, so what goes back on the wire is the
    // rest of the file — the difference between resuming a recording and starting
    // it over.
    expect(agent.parts.map((one) => Number(one.url.searchParams.get("offset")))).toEqual([
      PART,
      PART * 2,
    ]);
    expect(stored.complete).toBe(true);
    // And the bar starts where the file already is. A resume reporting zero would
    // show a nearly-finished upload as barely begun.
    expect(seen.map((one) => one.loaded)).toContain(PART);
  });

  test("sends the whole file to an agent that reports no windows", async () => {
    // An agent deployed before `ranges` existed answers the same way an empty
    // upload does, so a resume against one degrades to re-sending rather than to a
    // hole in the file.
    const agent = scriptAgent({ begin: 409, landed: [] });
    const stored = await client().uploadStream("abc", recording(), { resume: true });
    expect(agent.parts).toHaveLength(3);
    expect(stored.complete).toBe(true);
  });

  test("sends nothing at all when the store already has every window", async () => {
    const agent = scriptAgent({ begin: 409, landed: [{ start: 0, end: TOTAL }] });
    const stored = await client().uploadStream("abc", recording(), { resume: true });
    expect(agent.parts).toHaveLength(0);
    expect(stored.complete).toBe(true);
  });

  test("reports the transport's own failure when the retry fails too", async () => {
    scriptAgent();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/parts") && init?.method === "POST") {
          return json(201, record(0, false));
        }
        throw new TypeError("the upload did not reach the agent");
      }),
    );
    // On virtual time: a link that never comes back spends the resume budget as
    // well as the request one, which is tens of seconds of real waiting and a spec
    // that races the tier timeout rather than asserting anything about the delay.
    await expect(
      withoutBackoff(() => client().upload(recording(), { parallel: true })),
    ).rejects.toThrow(/did not reach the agent/);
  });
});

describe("progress over several connections", () => {
  test("describes the FILE, not whichever part reported last", async () => {
    scriptAgent();
    const seen: UploadProgress[] = [];
    await client().upload(recording(), {
      parallel: true,
      onProgress: (progress) => seen.push(progress),
    });
    // A bar exists from the submit, and its total is the whole file rather than a
    // part's — a bar that restarted per part would run three times to 8 MB.
    expect(seen[0]).toEqual({ loaded: 0, total: TOTAL, fraction: 0 });
    expect(seen.every((one) => one.total === TOTAL)).toBe(true);
    // It only ever grows, which is what parts landing in any order threatens.
    expect(seen.map((one) => one.loaded).toSorted((a, b) => a - b)).toEqual(
      seen.map((one) => one.loaded),
    );
    expect(seen.at(-1)).toEqual({ loaded: TOTAL, total: TOTAL, fraction: 1 });
  });

  test("a retried part gives back its own bytes rather than counting them twice", async () => {
    scriptAgent({ refuse: { offset: PART, network: true } });
    const seen: UploadProgress[] = [];
    await client().upload(recording(), {
      parallel: true,
      onProgress: (progress) => seen.push(progress),
    });
    // The bar may go backwards here — that is the honest report of a part being
    // resent — but it may never claim more than the file.
    expect(seen.every((one) => one.loaded <= TOTAL)).toBe(true);
    expect(seen.at(-1)?.loaded).toBe(TOTAL);
  });
});

describe("planning the windows", () => {
  test("rounds a part size UP to a whole chunk, never down to zero", () => {
    // Down would be a plan of infinitely many empty parts; the floor is one chunk.
    expect(planParts(UPLOAD_CHUNK_BYTES * 2, 1)).toEqual([
      { start: 0, end: UPLOAD_CHUNK_BYTES, index: 0 },
      { start: UPLOAD_CHUNK_BYTES, end: UPLOAD_CHUNK_BYTES * 2, index: 1 },
    ]);
  });

  test("plans nothing for an empty file", () => {
    expect(planParts(0, PART)).toEqual([]);
  });

  test("declines one part, and re-cuts it at a chunk when it must be resumable", () => {
    // Two whole chunks at the default part size is one window, which the speed-only
    // caller declines and the resumable one cuts into windows a resume can address.
    const small = recording(UPLOAD_CHUNK_BYTES * 2);
    expect(partsPlan(small, {})).toBeUndefined();
    expect(partsPlan(small, {}, { resumable: true })).toEqual({
      total: UPLOAD_CHUNK_BYTES * 2,
      parts: [
        { start: 0, end: UPLOAD_CHUNK_BYTES, index: 0 },
        { start: UPLOAD_CHUNK_BYTES, end: UPLOAD_CHUNK_BYTES * 2, index: 1 },
      ],
    });
    // A file under one chunk has nothing finer to be cut into, so it stays one
    // window — resumable in SHAPE, which is what stops the 409.
    expect(partsPlan(recording(1024), {}, { resumable: true })?.parts).toEqual([
      { start: 0, end: 1024, index: 0 },
    ]);
    // And an empty file declines either way: nothing to send, nothing to resume.
    expect(partsPlan(recording(0), {}, { resumable: true })).toBeUndefined();
  });
});
