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
  UPLOAD_CHUNK_BYTES,
  UPLOAD_PART_ATTEMPTS,
  UPLOAD_RETRY_BASE_MS,
  UPLOAD_RETRY_MAX_MS,
} from "./constants.ts";
import { createWorkflowApiClient } from "./workflow-api-client.ts";
import type { UploadProgress } from "./workflow-upload-client.ts";
import { planParts } from "./workflow-upload-parts.ts";

const BASE = "https://agents.example/my-agent/";

function client() {
  return createWorkflowApiClient({ baseUrl: BASE });
}

/** One request the client made, reduced to what a spec asks about. */
type Call = { method: string; url: URL; bytes: number; signal?: AbortSignal | undefined };

/** What the routes answer, and what the client asked them. */
type Agent = {
  calls: Call[];
  /** Requests to `…/parts`, in the order they were ISSUED. */
  parts: Call[];
  /** How many part requests were in flight at the busiest moment. */
  peak: number;
  /** Offsets whose HELD request was aborted rather than answered. */
  aborted: number[];
};

/** How a scripted agent answers one request. */
type Script = {
  /**
   * Status for the `POST …/parts` declaration, 201 unless a spec says otherwise —
   * or one status per attempt, for a claim that is retried.
   */
  begin?: number | readonly number[];
  /** Status per `GET …/info` read. 200 unless a spec says otherwise. */
  info?: readonly number[];
  /**
   * Windows the store already holds, reported by the FIRST `…/info` read.
   *
   * What a resume reads to work out what is missing. Only the first read, because
   * the one at the end of the fan-out is the finished record.
   */
  landed?: readonly { start: number; end: number }[];
  /** Answer for the part at this offset, first attempt only — or `always`. */
  refuse?: {
    offset: number;
    status?: number;
    network?: boolean;
    always?: boolean;
    /** `Retry-After` on the refusal, when a spec is about the wait. */
    retryAfter?: string;
  };
  /**
   * Offsets whose part request NEVER answers until it is aborted.
   *
   * The only way to observe that a doomed fan-out stops: a part the fake answers
   * has already finished by the time its sibling fails, so nothing is left to
   * abort. Held ones are still in flight, which is the case that costs a link.
   */
  hold?: readonly number[];
};

/**
 * A `fetch` that behaves like an agent serving the parts routes.
 *
 * It also records CONCURRENCY, which is the one property of this path that cannot
 * be read off the requests after the fact: each part is held until every part that
 * can be in flight has been issued, so the peak is observable rather than a race.
 */
function scriptAgent(script: Script = {}): Agent {
  const agent: Agent = { calls: [], parts: [], peak: 0, aborted: [] };
  const flight = { now: 0 };
  const refused = new Set<number>();
  const attempts = { begin: 0, info: 0 };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const call = {
        method: init?.method ?? "GET",
        url,
        bytes: bodyBytes(init?.body),
        signal: init?.signal ?? undefined,
      };
      agent.calls.push(call);
      if (url.pathname.endsWith("/parts")) {
        if (call.method !== "POST") return await answerPart(agent, flight, refused, script, call);
        attempts.begin += 1;
        return answerBegin(script, attempts.begin);
      }
      // `…/info` is the record a resume reads and the one read back at the end;
      // anything else is the ordinary single-request writer, which every declining
      // path falls to.
      if (!url.pathname.endsWith("/info")) return json(201, record(call.bytes, true));
      attempts.info += 1;
      return answerInfo(script, attempts.info);
    }),
  );
  return agent;
}

/** The declaration: 201 unless a spec is playing an agent that has no such route. */
function answerBegin(script: Script, attempt: number): Response {
  const declared = script.begin ?? 201;
  const status = typeof declared === "number" ? declared : (declared[attempt - 1] ?? 201);
  return json(status, status === 201 ? record(0, false) : { error: "no such route" });
}

/**
 * The record, as a resume reads it and as the fan-out reads it back.
 *
 * The FIRST read is the one a resume makes, so it is the only one `landed` answers
 * — the one at the end of the fan-out is the finished upload.
 */
function answerInfo(script: Script, attempt: number): Response {
  const status = script.info?.[attempt - 1] ?? 200;
  if (status !== 200) return json(status, { error: "no" });
  if (!script.landed || attempt !== 1) return json(200, record(TOTAL, true));
  const first = script.landed[0];
  // The contiguous prefix, which is what the store would publish as `size`.
  const prefix = first?.start === 0 ? first.end : 0;
  return json(200, { ...record(prefix, false), ranges: script.landed });
}

/**
 * One part, recording how many were in flight while it was.
 *
 * The two yields are what make the peak observable rather than a race: a pool that
 * issued its requests one after another reports 1, and one that overlaps them
 * reports its width.
 */
async function answerPart(
  agent: Agent,
  flight: { now: number },
  refused: Set<number>,
  script: Script,
  call: Call,
): Promise<Response> {
  agent.parts.push(call);
  flight.now += 1;
  agent.peak = Math.max(agent.peak, flight.now);
  await Promise.resolve();
  await Promise.resolve();
  flight.now -= 1;
  const offset = Number(call.url.searchParams.get("offset"));
  if (script.hold?.includes(offset)) {
    return await new Promise<Response>((_resolve, reject) => {
      const signal = call.signal;
      if (!signal) return;
      signal.addEventListener("abort", () => {
        agent.aborted.push(offset);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }
  if (script.refuse?.offset === offset && (script.refuse.always || !refused.has(offset))) {
    refused.add(offset);
    if (script.refuse.network) throw new TypeError("the upload did not reach the agent");
    return json(
      script.refuse.status ?? 400,
      { error: "refused" },
      script.refuse.retryAfter === undefined
        ? undefined
        : { "Retry-After": script.refuse.retryAfter },
    );
  }
  return json(200, record(offset + call.bytes, false));
}

/** Bytes in a request body, whatever shape it took. */
function bodyBytes(body: unknown): number {
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return typeof body === "string" ? body.length : 0;
}

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/**
 * Run an upload that waits out backoffs, on VIRTUAL time.
 *
 * The retries are seconds apart by design, so a spec that lets them elapse is a
 * spec that spends them — and one that is racing a 5s tier timeout. The clock is
 * advanced in whole {@link UPLOAD_RETRY_MAX_MS} steps until the upload settles,
 * which is the largest wait `retryDelay` can ever produce.
 */
/**
 * End an upload a spec deliberately left unfinished, and wait for it to stop.
 *
 * Without this the upload outlives the test: it is still waiting out a backoff when
 * the spec returns, and it wakes against the NEXT spec's stubbed `fetch` and issues
 * its remaining parts into that spec's agent. Two specs here observe a retry WITHOUT
 * letting it finish, and both need it.
 */
async function settle(abandon: AbortController, work: Promise<unknown>): Promise<void> {
  abandon.abort();
  await vi.advanceTimersByTimeAsync(0);
  await work.catch(() => undefined);
}

async function withoutBackoff<T>(start: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    let settled = false;
    const work = start().finally(() => {
      settled = true;
    });
    // Attached before the loop so a rejection is never momentarily unhandled; the
    // real outcome is still what this returns.
    work.catch(() => undefined);
    while (!settled) await vi.advanceTimersByTimeAsync(UPLOAD_RETRY_MAX_MS);
    return await work;
  } finally {
    vi.useRealTimers();
  }
}

function record(size: number, complete: boolean) {
  return { id: "abc", name: "call.wav", type: "audio/wav", size, complete };
}

/** A file of three whole parts at the default part size. */
const TOTAL = 24 * 1024 * 1024;
const PART = 8 * 1024 * 1024;

/** A recording, as a `File` off a picker. */
function recording(bytes = TOTAL): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "audio/wav" });
}

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
    // Eight parts against the default concurrency of four.
    await client().upload(recording(PART * 8), { parallel: true });
    expect(agent.parts).toHaveLength(8);
    expect(agent.peak).toBe(4);
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
  test("an agent with no parts routes gets the single request instead", async () => {
    const agent = scriptAgent({ begin: 404 });
    const stored = await client().upload(recording(), { name: "call.wav", parallel: true });
    // One declaration that was refused, then the ordinary POST — the file has not
    // moved yet when the fallback is decided, so it costs a round trip.
    expect(agent.parts).toHaveLength(0);
    const [, fallback] = agent.calls;
    expect(fallback?.method).toBe("POST");
    expect(fallback?.url.pathname).toMatch(/\/uploads$/);
    expect(fallback?.bytes).toBe(TOTAL);
    expect(stored.complete).toBe(true);
  });

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
    // hears, not an invented one.
    expect(
      agent.parts.filter((one) => one.url.searchParams.get("offset") === String(PART)),
    ).toHaveLength(UPLOAD_PART_ATTEMPTS);
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
    await expect(client().upload(recording(), { parallel: true })).rejects.toThrow(
      /did not reach the agent/,
    );
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
});
