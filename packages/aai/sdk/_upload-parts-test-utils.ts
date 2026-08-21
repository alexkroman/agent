// Copyright 2026 the AAI authors. MIT license.
/**
 * The scripted agent every PARTS spec is driven against, and the two suites share it.
 *
 * It lived inside `workflow-upload-parts.test.ts` until the DIRECT path arrived and
 * needed the same fake — and a fake copied into two files is the drift this repo keeps
 * paying for, most sharply in this feature: `_upload-store-test-utils.ts` says the same
 * thing about `recordingDb`, whose two independent copies each silently answered `[]`.
 *
 * A scripted `fetch` rather than a server, because everything asserted over it is a
 * property of the REQUESTS the client issues. The server's half is pinned in
 * `host/workflow-api-uploads.test.ts` against a real router.
 */

import { vi } from "vitest";
import { UPLOAD_PART_BYTES, UPLOAD_RETRY_MAX_MS } from "./constants.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { createWorkflowApiClient } from "./workflow-api-client.ts";

export const BASE = "https://agents.example/my-agent/";

export function client(opts: { token?: string } = {}) {
  return createWorkflowApiClient({ baseUrl: BASE, ...omitUndefined({ token: opts.token }) });
}

/** One request the client made, reduced to what a spec asks about. */
export type Call = {
  method: string;
  url: URL;
  bytes: number;
  /** Lower-cased request headers, for the specs about which surface a bearer reaches. */
  headers: Record<string, string>;
  signal?: AbortSignal | undefined;
};

/** What the routes answer, and what the client asked them. */
export type Agent = {
  calls: Call[];
  /** Requests to `…/parts`, in the order they were ISSUED. */
  parts: Call[];
  /** How many part requests were in flight at the busiest moment. */
  peak: number;
  /** Offsets whose HELD request was aborted rather than answered. */
  aborted: number[];
  /** Requests that carried BYTES to the platform's own byte route. */
  bytes: Call[];
};

/** How a scripted agent answers one request. */
export type Script = {
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
  /** Answer for the part at this offset, first attempt only — or `always`/`times`. */
  refuse?: {
    offset: number;
    status?: number;
    network?: boolean;
    always?: boolean;
    /**
     * Refuse the first N attempts and answer the rest.
     *
     * What an agent that went away and came BACK looks like from one part: set it
     * to the per-request budget and the whole first round fails, which is the only
     * way to reach the client's own resume loop (`_upload-resume.ts`) from a spec.
     * `always` cannot — nothing ever succeeds — and the default cannot, since one
     * refusal is absorbed by the retry inside the round.
     */
    times?: number;
    /** `Retry-After` on the refusal, when a spec is about the wait. */
    retryAfter?: string;
  };
  /**
   * Whether the claim advertises `directParts` — a DEPLOYED agent, whose bytes go to
   * the platform's own route rather than to it.
   */
  direct?: boolean;
  /**
   * How many landed offsets the claim says one request may name (`claimBatch`).
   *
   * Absent means the field is OMITTED, which is an agent that predates batching and
   * the answer a client must read as "one offset per claim". Only meaningful
   * alongside {@link Script.direct}, exactly as the route only sends it there.
   */
  claimBatch?: number;
  /**
   * Whether the CLOSING `…/info` read reports an upload that never got recorded.
   *
   * The production shape: every window was sent and acknowledged, and the store
   * measured each as zero bytes, so the record answers `size: 0, complete: false`
   * over a file whose bytes are all in the bucket. A spec asks for it because the
   * client's own answer to it — reporting success, or refusing — is the difference
   * between a run that fails on an empty file and one that never starts.
   */
  neverRecorded?: boolean;
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
export function scriptAgent(script: Script = {}): Agent {
  const agent: Agent = { calls: [], parts: [], peak: 0, aborted: [], bytes: [] };
  const flight = { now: 0 };
  const refusals = new Map<number, number>();
  const attempts = { begin: 0, info: 0 };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const call = {
        method: init?.method ?? "GET",
        url,
        bytes: bodyBytes(init?.body),
        headers: lowerKeys(init?.headers),
        signal: init?.signal ?? undefined,
      };
      agent.calls.push(call);
      // The PLATFORM's byte route, which is not under the API prefix at all — that is
      // the whole point of it. Matched first, because everything below assumes the
      // path is one of the agent's own.
      if (!url.pathname.includes("/workflows/")) {
        return answerBytes(agent, refusals, script, call);
      }
      if (url.pathname.endsWith("/parts")) {
        if (call.method !== "POST") return await answerPart(agent, flight, refusals, script, call);
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

/**
 * One window on the DIRECT path, at the platform's own route.
 *
 * `refuse` applies here too, keyed by the offset in the PATH rather than in a query
 * parameter: on that path the byte write is what a spec about a failed part has to be
 * able to fail.
 */
function answerBytes(
  agent: Agent,
  refusals: Map<number, number>,
  script: Script,
  call: Call,
): Response {
  agent.bytes.push(call);
  const at = Number(call.url.pathname.split("/").at(-1));
  if (script.refuse?.offset === at && stillRefusing(script, refusals, at)) {
    if (script.refuse.network) throw new TypeError("the upload did not reach the platform");
    return json(script.refuse.status ?? 400, { error: "refused" });
  }
  return json(201, { bytes: call.bytes });
}

/**
 * Whether this offset is still being refused, counting the refusals so far.
 *
 * Three modes in one line, because they are three points on the same axis: refuse
 * forever (`always`), refuse the first N (`times` — an agent that came back), or
 * refuse once (the default, absorbed by the retry inside a round).
 */
function stillRefusing(script: Script, refusals: Map<number, number>, offset: number): boolean {
  const refuse = script.refuse;
  if (!refuse) return false;
  const soFar = refusals.get(offset) ?? 0;
  const limit = refuse.always ? Number.POSITIVE_INFINITY : (refuse.times ?? 1);
  if (soFar >= limit) return false;
  refusals.set(offset, soFar + 1);
  return true;
}

/** The declaration: 201 unless a spec is playing an agent that has no such route. */
function answerBegin(script: Script, attempt: number): Response {
  const declared = script.begin ?? 201;
  const status = typeof declared === "number" ? declared : (declared[attempt - 1] ?? 201);
  if (status !== 201) return json(status, { error: "no such route" });
  // Omitted rather than false when the bytes come to the agent, exactly as the route
  // omits it — so a fake cannot make the client take a path a real agent would not.
  return json(201, {
    ...record(0, false),
    directParts: script.direct ? true : undefined,
    // Omitted unless a spec asks for it, and only on the direct path — the two
    // capabilities shipped separately, so a fake that coupled them could not
    // reproduce the skew the client's own default exists for.
    claimBatch: script.direct ? script.claimBatch : undefined,
  });
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
  // The closing read, which is every read but a resume's first. `neverRecorded` is
  // what a store that acknowledged each window and recorded none answers with.
  // The same two capability fields the CLAIM answers with. The real route sends them
  // here too, and it has to: a resume's claim is answered 409, which carries no body,
  // so this read is the only place the client can learn where its remaining windows
  // go. A fake that omitted them would make every resume spec measure the fallback.
  const capability = script.direct
    ? { directParts: true, claimBatch: script.claimBatch }
    : undefined;
  if (!script.landed || attempt !== 1) {
    return json(200, {
      ...(script.neverRecorded ? record(0, false) : record(TOTAL, true)),
      ...capability,
    });
  }
  const first = script.landed[0];
  // The contiguous prefix, which is what the store would publish as `size`.
  const prefix = first?.start === 0 ? first.end : 0;
  return json(200, { ...record(prefix, false), ranges: script.landed, ...capability });
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
  refusals: Map<number, number>,
  script: Script,
  call: Call,
): Promise<Response> {
  agent.parts.push(call);
  flight.now += 1;
  agent.peak = Math.max(agent.peak, flight.now);
  await Promise.resolve();
  await Promise.resolve();
  flight.now -= 1;
  // A BATCHED claim names several — see `Script.claimBatch` — so `hold` and `refuse`
  // match on ANY offset the request carries. The first one is what the request is
  // named by in the ledgers, which for the unbatched form is the only one there is.
  const offsets = call.url.searchParams.getAll("offset").map(Number);
  const held = script.hold?.find((one) => offsets.includes(one));
  if (held !== undefined) {
    return await new Promise<Response>((_resolve, reject) => {
      const signal = call.signal;
      if (!signal) return;
      signal.addEventListener("abort", () => {
        agent.aborted.push(held);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }
  const refused = script.refuse;
  if (
    refused !== undefined &&
    offsets.includes(refused.offset) &&
    stillRefusing(script, refusals, refused.offset)
  ) {
    if (refused.network) throw new TypeError("the upload did not reach the agent");
    return json(
      refused.status ?? 400,
      { error: "refused" },
      refused.retryAfter === undefined ? undefined : { "Retry-After": refused.retryAfter },
    );
  }
  // The largest window named, which for a batch is the furthest the record could
  // have reached — the real store publishes the contiguous prefix and this fake's
  // callers only read that it answered.
  return json(200, record(Math.max(...offsets) + call.bytes, false));
}

/** Request headers as a plain lower-cased record, whatever shape they arrived in. */
function lowerKeys(headers: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries((headers ?? {}) as Record<string, string>)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

/** Bytes in a request body, whatever shape it took. */
function bodyBytes(body: unknown): number {
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return typeof body === "string" ? body.length : 0;
}

export function json(status: number, body: unknown, headers?: Record<string, string>): Response {
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
export async function settle(abandon: AbortController, work: Promise<unknown>): Promise<void> {
  abandon.abort();
  await vi.advanceTimersByTimeAsync(0);
  await work.catch(() => undefined);
}

export async function withoutBackoff<T>(start: () => Promise<T>): Promise<T> {
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

export function record(size: number, complete: boolean) {
  return { id: "abc", name: "call.wav", type: "audio/wav", size, complete };
}

/** A file of three whole parts at the default part size. */
export const PART = UPLOAD_PART_BYTES;
/**
 * A file of exactly three whole parts, DERIVED from the part size.
 *
 * Both used to be literals, and the day `UPLOAD_PART_BYTES` moved from 8 MiB to
 * 4 they took eleven specs down with them — every one asserting a part COUNT that
 * is a function of the constant, not a fact about the file. Derived, a change to
 * the default is a one-line change here and nowhere else.
 */
export const TOTAL = PART * 3;

/** A recording, as a `File` off a picker. */
export function recording(bytes = TOTAL): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "audio/wav" });
}
