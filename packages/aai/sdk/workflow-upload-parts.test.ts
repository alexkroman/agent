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
import { UPLOAD_CHUNK_BYTES } from "./constants.ts";
import { createWorkflowApiClient } from "./workflow-api-client.ts";
import type { UploadProgress } from "./workflow-upload-client.ts";
import { planParts } from "./workflow-upload-parts.ts";

const BASE = "https://agents.example/my-agent/";

function client() {
  return createWorkflowApiClient({ baseUrl: BASE });
}

/** One request the client made, reduced to what a spec asks about. */
type Call = { method: string; url: URL; bytes: number };

/** What the routes answer, and what the client asked them. */
type Agent = {
  calls: Call[];
  /** Requests to `…/parts`, in the order they were ISSUED. */
  parts: Call[];
  /** How many part requests were in flight at the busiest moment. */
  peak: number;
};

/** How a scripted agent answers one request. */
type Script = {
  /** Status for the `POST …/parts` declaration. 201 unless a spec says otherwise. */
  begin?: number;
  /** Answer for the part at this offset, first attempt only. */
  refuse?: { offset: number; status?: number; network?: boolean };
};

/**
 * A `fetch` that behaves like an agent serving the parts routes.
 *
 * It also records CONCURRENCY, which is the one property of this path that cannot
 * be read off the requests after the fact: each part is held until every part that
 * can be in flight has been issued, so the peak is observable rather than a race.
 */
function scriptAgent(script: Script = {}): Agent {
  const agent: Agent = { calls: [], parts: [], peak: 0 };
  const flight = { now: 0 };
  const refused = new Set<number>();

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const call = { method: init?.method ?? "GET", url, bytes: bodyBytes(init?.body) };
      agent.calls.push(call);
      if (url.pathname.endsWith("/parts")) {
        return call.method === "POST"
          ? answerBegin(script)
          : await answerPart(agent, flight, refused, script, call);
      }
      // `…/info` is the record read back at the end; anything else is the ordinary
      // single-request writer, which every declining path falls to.
      return url.pathname.endsWith("/info")
        ? json(200, record(TOTAL, true))
        : json(201, record(call.bytes, true));
    }),
  );
  return agent;
}

/** The declaration: 201 unless a spec is playing an agent that has no such route. */
function answerBegin(script: Script): Response {
  const status = script.begin ?? 201;
  return json(status, status === 201 ? record(0, false) : { error: "no such route" });
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
  if (script.refuse?.offset === offset && !refused.has(offset)) {
    refused.add(offset);
    if (script.refuse.network) throw new TypeError("the upload did not reach the agent");
    return json(script.refuse.status ?? 400, { error: "refused" });
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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

  test("`parallel: false` is the same as not asking", async () => {
    const agent = scriptAgent();
    await client().upload(recording(), { parallel: false });
    expect(agent.calls).toHaveLength(1);
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
