// Copyright 2026 the AAI authors. MIT license.
/**
 * `forwardToGuest`'s three deadline bounds.
 *
 * The header filters are asserted where they matter — `workflow-handler.test.ts`
 * and `workflow-webhook-handler.test.ts` drive them through a real
 * orchestrator. What can only be seen here is the DEADLINE, because a bound is
 * a claim about time and an orchestrator test cannot pace a request body.
 *
 * The pair that carries the file is `progresses under "activity"` against
 * `progresses under "headers"`: the SAME script, differing only in the bound,
 * one resolving and one aborting. That is the shipped bug — `POST
 * /workflows/uploads` answers 201 only once the last byte is stored, so a
 * head-only deadline bounded the whole transfer and a 500 MB recording needed
 * ~133 Mbps to beat 30s.
 *
 * Virtual time throughout: a spec that waits out real milliseconds to see
 * whether a window elapsed is a race, and the flake then names the timing spec
 * rather than the bug.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  forwardToGuest,
  GUEST_API_RESPONSE_HEADERS,
  GUEST_WEBHOOK_RESPONSE_HEADERS,
  NEVER_FORWARDED,
  passThroughHeaders,
  pickHeaders,
} from "./guest-forward.ts";

const TIMEOUT_MS = 1000;

/** A request body the test feeds by hand, recording whether it was cancelled. */
function pushableBody() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    /** One chunk, ignored once the stream is gone — an abort races the script. */
    push(): void {
      try {
        controller?.enqueue(new Uint8Array([1]));
      } catch {
        // Already cancelled by the deadline; the assertion is on the forward.
      }
    },
    close(): void {
      try {
        controller?.close();
      } catch {
        // Same.
      }
    },
    get cancelled() {
      return cancelled;
    },
  };
}

/**
 * A guest that drains the request body and then answers.
 *
 * It has to honour `signal` the way undici does — REJECTING with the abort
 * reason — because "the deadline fired" and "the guest answered" are the two
 * outcomes every test here distinguishes. Cancelling the reader is what makes
 * the pending `read()` settle; the flag is what turns that into a throw rather
 * than a clean end.
 */
function drainingGuest(answer: () => Response = () => new Response("{}", { status: 200 })) {
  const fetchFn: typeof globalThis.fetch = async (_url, init) => {
    const body = init?.body;
    const signal = init?.signal ?? null;
    if (body instanceof ReadableStream) {
      const reader = body.getReader();
      let abortReason: unknown;
      const onAbort = (): void => {
        abortReason = signal?.reason ?? new Error("aborted");
        void reader.cancel(abortReason);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      for (;;) {
        const { done } = await reader.read();
        if (abortReason !== undefined) throw abortReason;
        if (done) break;
      }
    }
    return answer();
  };
  return fetchFn;
}

/**
 * A guest that takes the whole body at once and answers `answerAfterMs` later.
 *
 * undici, modelled: it accepts a stream body into its own write buffer far ahead
 * of the socket (measured against a real reader — 5 MiB handed over in 10ms
 * while the far end had 0.6 MiB), so every re-arm happens up front and the time
 * the guest spends STORING those bytes falls entirely inside the last budget
 * armed. That is the production shape `transferTimeoutMs` exists for and the one
 * `drainingGuest` cannot show, because it answers the instant the body ends.
 */
function digestingGuest(answerAfterMs: number) {
  const fetchFn: typeof globalThis.fetch = async (_url, init) => {
    const body = init?.body;
    if (body instanceof ReadableStream) {
      const reader = body.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
    const signal = init?.signal ?? null;
    return await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response("{}", { status: 200 })), answerAfterMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  };
  return fetchFn;
}

/** A guest that never answers at all, so only the deadline can settle the call. */
const silentGuest: typeof globalThis.fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Settle a forward into an outcome object, attaching the handler NOW.
 *
 * Every test here rejects its forward from inside
 * `vi.advanceTimersByTimeAsync`, which runs real macrotask ticks — so a handler
 * attached afterwards (`await expect(forward).rejects`) is attached too late and
 * Node reports the rejection as unhandled, failing the file while every
 * assertion passes. Capturing before the clock moves is the fix, and it is the
 * reason this is a helper rather than a `try`/`catch` per test.
 */
function capture<T>(promise: Promise<T>): Promise<{ res?: T; err?: unknown }> {
  return promise.then(
    (res) => ({ res }),
    (err: unknown) => ({ err }),
  );
}

/**
 * Advance to just under the deadline, deliver a chunk, then advance again — a
 * transfer that is slow but never stalls, and whose total exceeds the deadline.
 */
async function paced(bound: "headers" | "activity", body: ReturnType<typeof pushableBody>) {
  const forward = forwardToGuest({
    fetchFn: drainingGuest(),
    url: "https://tunnel.test/workflows/uploads",
    method: "POST",
    body: body.stream,
    timeoutMs: TIMEOUT_MS,
    bound,
  });
  const settled = capture(forward);
  await vi.advanceTimersByTimeAsync(800);
  body.push();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(400);
  body.close();
  await vi.advanceTimersByTimeAsync(0);
  return await settled;
}

describe('bound: "activity"', () => {
  test("a slow but progressing request body outlives the deadline", async () => {
    // 1200ms of transfer against a 1000ms deadline: every chunk drained re-arms
    // it, so the only thing that can fail is a STALL.
    const body = pushableBody();
    const outcome = await paced("activity", body);
    expect(outcome).toMatchObject({ res: { status: 200 } });
    expect(body.cancelled).toBe(false);
  });

  test("the same script under the old bound aborts mid-transfer", async () => {
    // The regression twin. Progress buys nothing when the deadline is a total,
    // which is what made a 500 MB upload a 503 at 30.3s on the platform and
    // fine under `aai dev`, where there is no forward and no deadline.
    const body = pushableBody();
    const outcome = await paced("headers", body);
    expect(outcome).toMatchObject({ err: expect.objectContaining({ name: "AbortError" }) });
    // And the inbound body is released rather than left for nobody to drain.
    expect(body.cancelled).toBe(true);
  });

  test("a STALLED request body still aborts on time", async () => {
    const body = pushableBody();
    const forward = forwardToGuest({
      fetchFn: drainingGuest(),
      url: "https://tunnel.test/workflows/uploads",
      method: "POST",
      body: body.stream,
      timeoutMs: TIMEOUT_MS,
      bound: "activity",
    });
    const settled = capture(forward);
    await vi.advanceTimersByTimeAsync(800);
    body.push();
    await vi.advanceTimersByTimeAsync(0);
    // Nothing more arrives: one full budget with no progress is the failure this
    // bound still has to report, or it is not a deadline at all.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
    expect(await settled).toMatchObject({ err: expect.objectContaining({ name: "AbortError" }) });
  });

  test("it disarms on the response head, so an endless body is left alone", async () => {
    const endless = new ReadableStream<Uint8Array>({ start: () => undefined });
    const res = await forwardToGuest({
      fetchFn: () => Promise.resolve(new Response(endless, { status: 200 })),
      url: "https://tunnel.test/workflows/runs/wrun_1/events",
      timeoutMs: TIMEOUT_MS,
      bound: "activity",
    });
    expect(res.status).toBe(200);
    // No timer survives the call, so nothing can abort the stream later — the
    // truncated chunked response `live-streams.ts` exists to prevent.
    expect(vi.getTimerCount()).toBe(0);
  });

  test("the TRANSFER window covers digesting the body, not one round trip", async () => {
    // The regression. Every chunk is taken up front, so what is left running is
    // the window armed by the last pull — and the guest is still persisting bytes
    // the forward has already let go of. Under a flat `timeoutMs` this aborted at
    // the deadline while nothing was wrong, which is 27 upload `PUT`s in an hour
    // of production log answering 503 between 30.3s and 34.1s.
    const body = pushableBody();
    const forward = forwardToGuest({
      fetchFn: digestingGuest(TIMEOUT_MS * 3),
      url: "https://tunnel.test/workflows/uploads/upl_1/parts?offset=0",
      method: "PUT",
      body: body.stream,
      timeoutMs: TIMEOUT_MS,
      transferTimeoutMs: TIMEOUT_MS * 5,
      bound: "activity",
    });
    const settled = capture(forward);
    body.push();
    body.close();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3 + 1);
    expect(await settled).toMatchObject({ res: { status: 200 } });
  });

  test("a guest that swallowed the body and DIED still fails, on the transfer window", async () => {
    // The other half: the window is longer, not absent. A guest that takes every
    // byte and never answers is the failure this deadline still has to report.
    const body = pushableBody();
    const forward = forwardToGuest({
      fetchFn: digestingGuest(TIMEOUT_MS * 100),
      url: "https://tunnel.test/workflows/uploads/upl_1/parts?offset=0",
      method: "PUT",
      body: body.stream,
      timeoutMs: TIMEOUT_MS,
      transferTimeoutMs: TIMEOUT_MS * 5,
      bound: "activity",
    });
    const settled = capture(forward);
    body.push();
    body.close();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 5 + 1);
    expect(await settled).toMatchObject({ err: expect.objectContaining({ name: "AbortError" }) });
  });

  test("without transferTimeoutMs the window is timeoutMs, unchanged", async () => {
    // Default preserved, so the two other callers on this helper keep the bound
    // they were written against.
    const body = pushableBody();
    const forward = forwardToGuest({
      fetchFn: digestingGuest(TIMEOUT_MS * 3),
      url: "https://tunnel.test/workflows/uploads",
      method: "POST",
      body: body.stream,
      timeoutMs: TIMEOUT_MS,
      bound: "activity",
    });
    const settled = capture(forward);
    body.push();
    body.close();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
    expect(await settled).toMatchObject({ err: expect.objectContaining({ name: "AbortError" }) });
  });

  test("a buffered body needs no branch at the call site", async () => {
    // `"activity"` degrades to `"headers"` when there is nothing to measure,
    // which is why the workflow route passes it for every method.
    const res = await forwardToGuest({
      fetchFn: drainingGuest(),
      url: "https://tunnel.test/workflows/runs",
      method: "POST",
      body: JSON.stringify({ workflow: "digest" }),
      timeoutMs: TIMEOUT_MS,
      bound: "activity",
    });
    expect(res.status).toBe(200);
  });
});

describe("the other two bounds are unchanged", () => {
  test('"response" (the default) still takes the un-rearmable signal', async () => {
    // Asserted STRUCTURALLY rather than by waiting the deadline out, because
    // `AbortSignal.timeout` is one of the waits `vi.useFakeTimers()` does not
    // patch: driving that branch really costs `timeoutMs` of wall clock, which
    // is the flake-first shape this repo keeps out of the unit tier.
    //
    // What it pins is the one regression the bound normalization can cause. The
    // branch is `bound === "response" ? undefined : new AbortController()`, so
    // an omitted `bound` resolving to the wrong side would silently give the two
    // buffering callers (`/client-config`, the webhook) a deadline that the
    // request body could re-arm — and no test of theirs could see it.
    const armed: number[] = [];
    const counting: typeof globalThis.fetch = () => {
      armed.push(vi.getTimerCount());
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const url = "https://tunnel.test/client-config";
    await forwardToGuest({ fetchFn: counting, url, timeoutMs: TIMEOUT_MS });
    await forwardToGuest({ fetchFn: counting, url, timeoutMs: TIMEOUT_MS, bound: "response" });
    await forwardToGuest({ fetchFn: counting, url, timeoutMs: TIMEOUT_MS, bound: "headers" });
    // Omitted and explicit `"response"` agree, and only the hand-held bound
    // arms a timer of ours.
    expect(armed).toEqual([0, 0, 1]);
  });

  test('"headers" bounds a guest that never answers', async () => {
    const forward = forwardToGuest({
      fetchFn: silentGuest,
      url: "https://tunnel.test/workflows",
      timeoutMs: TIMEOUT_MS,
      bound: "headers",
    });
    const settled = capture(forward);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
    expect(await settled).toMatchObject({ err: expect.objectContaining({ name: "AbortError" }) });
  });
});

/**
 * The REQUEST strip set, which stays a DENY-LIST and is the only one left.
 *
 * It has no choice: the module doc records that a workflow verifying
 * `Stripe-Signature` needs headers this file cannot enumerate. So the property
 * that makes a deny-list auditable has to hold here — the whole set is the
 * reviewable unit, asserted as an equality rather than sampled per known name.
 * Its coverage used to be incidental, riding on the response set that was built
 * out of it; converting that direction to an allow-list left this one with none.
 */
describe("NEVER_FORWARDED", () => {
  test("is exactly the hop-by-hop set plus the three credential-bearing headers", () => {
    expect([...NEVER_FORWARDED].sort()).toEqual(
      [
        "authorization",
        "connection",
        "content-length",
        "cookie",
        "expect",
        "host",
        "keep-alive",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
      ].sort(),
    );
  });

  test("every entry is lower-cased, because that is what the filter compares", () => {
    // `passThroughHeaders` lower-cases the incoming name and then tests
    // `NEVER_FORWARDED.has(lower)`, so a capitalised entry is an entry that
    // matches nothing — and prints no error anywhere.
    expect([...NEVER_FORWARDED].filter((h) => h !== h.toLowerCase())).toEqual([]);
  });

  test("passes a header nobody enumerated, which is the point of this direction", () => {
    const fromSender = new Headers({
      "content-type": "application/json",
      "stripe-signature": "t=1,v1=deadbeef",
      "x-hub-signature-256": "sha256=abc",
    });
    expect([...passThroughHeaders(fromSender).keys()].sort()).toEqual([
      "content-type",
      "stripe-signature",
      "x-hub-signature-256",
    ]);
  });

  test("strips the credential set and every x-forwarded-*", () => {
    // One `Headers` carrying all of them at once: a per-name loop would pass on
    // a filter that stops after its first hit. `x-forwarded-*` is matched by
    // PREFIX rather than by membership, which is why it is exercised here and
    // cannot appear in the equality above.
    const fromSender = new Headers({ "content-type": "application/json" });
    for (const name of [...NEVER_FORWARDED]) fromSender.set(name, "caller-supplied");
    for (const name of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]) {
      fromSender.set(name, "platform-hop");
    }
    expect([...passThroughHeaders(fromSender).keys()]).toEqual(["content-type"]);
  });
});

/**
 * The API hop's RESPONSE allow-list, and the one name it was censoring.
 *
 * Pinned as a whole set rather than sampled, for the reason the webhook block
 * below gives.
 *
 * The pre-fix FAILING observation is `returns the guest's own Retry-After`. The
 * guest MINTS that header — `aai-runtime/workflow-api-error-status.ts` decides
 * per condition whether a 5xx carries one (`503` + `Retry-After: 1` for a
 * saturated connection pool, an exhausted descriptor table, or a failed hop out
 * of the sandbox; `507` with none for a full disk, where the ABSENCE is the
 * signal) and `workflow-api.ts` sets it. This hop dropped every one of them, so
 * a taxonomy written to be acted on reached a deployed caller as a bare status —
 * while the same guest reached over the WEBHOOK hop kept it. One product, two
 * answers, decided by which proxy the request happened to take.
 */
describe("GUEST_API_RESPONSE_HEADERS", () => {
  test("returns the guest's own Retry-After, so a 503 can be honoured", () => {
    // The readers are already shipped: `retryAfter()` in `aai/sdk/step-retry.ts`,
    // and `sdk/_upload-retry.ts`, which a browser uploading parts through
    // `/:slug/workflows/uploads` runs on every refusal — "the far side knows
    // something this does not" is that module's own argument for preferring it,
    // and the far side was being censored.
    const fromGuest = new Headers({
      "content-type": "application/json",
      "retry-after": "1",
    });
    const returned = pickHeaders(fromGuest, GUEST_API_RESPONSE_HEADERS);
    expect(returned.get("retry-after")).toBe("1");
    expect(returned.get("content-type")).toBe("application/json");
  });

  test("is exactly the set a caller on this hop reads", () => {
    // Spelled as an equality over the WHOLE list: a disappearing entry is a
    // broken caller and an appearing one is a tenant statement made on the
    // platform's origin, and a per-name membership test sees neither.
    expect([...GUEST_API_RESPONSE_HEADERS]).toEqual([
      "content-type",
      "content-length",
      "cache-control",
      "x-accel-buffering",
      "retry-after",
      "content-range",
      "accept-ranges",
      "content-disposition",
    ]);
  });

  test("every entry is lower-cased, because that is what the filter compares", () => {
    expect([...GUEST_API_RESPONSE_HEADERS].filter((h) => h !== h.toLowerCase())).toEqual([]);
  });

  test("still drops the origin-scoped headers, which Retry-After is not one of", () => {
    // The addition is a RETRY HINT — per-response, unpersisted, read by a retry
    // loop — so it does not touch the criterion the webhook list is built on.
    // Asserted beside it so a later widening cannot cite this one as precedent.
    const fromGuest = new Headers({ "content-type": "application/json" });
    for (const name of ["set-cookie", "location", "refresh", "content-security-policy"]) {
      fromGuest.set(name, "tenant-supplied");
    }
    const returned = pickHeaders(fromGuest, GUEST_API_RESPONSE_HEADERS);
    expect([...returned.keys()]).toEqual(["content-type"]);
  });

  test("does NOT merge with the webhook list, in either direction", () => {
    // The two now share `content-type` and `retry-after`, which is exactly when
    // somebody proposes one list. Their UNION is not either policy — the platform
    // buffers the webhook reply, so a length or a range there would describe
    // bytes the runtime re-frames — and their INTERSECTION is not either policy
    // either, since it drops `content-range` and takes the `Range` request half
    // with it. One list is one audience, and there are two.
    const api = new Set<string>(GUEST_API_RESPONSE_HEADERS);
    const webhook = new Set<string>(GUEST_WEBHOOK_RESPONSE_HEADERS);
    expect([...webhook].filter((h) => !api.has(h))).toEqual([]);
    expect([...api].filter((h) => !webhook.has(h))).toEqual([
      "content-length",
      "cache-control",
      "x-accel-buffering",
      "content-range",
      "accept-ranges",
      "content-disposition",
    ]);
  });
});

/**
 * The WEBHOOK hop's RESPONSE allow-list, asserted EXHAUSTIVELY rather than
 * sampled.
 *
 * An allow-list is only auditable if the whole set is the reviewable unit, so
 * these pin the set itself and not a few members of it — an entry silently
 * disappearing is a broken caller (`content-type`) and an entry silently
 * appearing is a tenant statement in the platform's voice, and a membership test
 * per known name cannot see either. The counterpart for the REQUEST direction,
 * and the header filters driven through a real orchestrator, live in
 * `workflow-handler.test.ts` and `workflow-webhook-handler.test.ts`.
 *
 * The pre-fix FAILING observation is `does not return a header nobody
 * enumerated`: against the 19-name deny-list this replaced, `Refresh`,
 * `Speculation-Rules` and `Integrity-Policy` all crossed this hop — three
 * browser-honoured, tenant-controlled headers, one of them a redirect under
 * another name. That is what a deny-list costs, and it is the reason `location`
 * is now omitted rather than excused.
 */
describe("GUEST_WEBHOOK_RESPONSE_HEADERS", () => {
  test("is exactly the two headers a webhook sender reads", () => {
    // Spelled as an equality over the WHOLE list. An addition here is a decision
    // about what a tenant may say on the platform's origin; a removal breaks
    // every caller. Both have to fail.
    expect([...GUEST_WEBHOOK_RESPONSE_HEADERS]).toEqual(["content-type", "retry-after"]);
  });

  test("every entry is lower-cased, because that is what the filter compares", () => {
    // `pickHeaders` calls `from.get(name)`, which IS case-insensitive — so a
    // capitalised entry would work and then read as licence to capitalise one
    // that has to match a `Set`. Same assertion as the request lists carry.
    expect([...GUEST_WEBHOOK_RESPONSE_HEADERS].filter((h) => h !== h.toLowerCase())).toEqual([]);
  });

  test("still returns what a webhook sender actually reads", () => {
    // The allow-list must not have quietly forgotten `content-type`: a sender
    // that cannot interpret the body sees an opaque reply, and a tenant
    // answering 429 cannot steer the retry loop without `Retry-After`.
    const fromGuest = new Headers({
      "content-type": "application/json",
      "retry-after": "30",
    });
    const returned = pickHeaders(fromGuest, GUEST_WEBHOOK_RESPONSE_HEADERS);
    expect(returned.get("content-type")).toBe("application/json");
    expect(returned.get("retry-after")).toBe("30");
  });

  test("strips every origin-scoped header a guest could send", () => {
    // The 19 names the deny-list enumerated, all at once: a per-name loop would
    // pass on a filter that stops after its first hit. Under an allow-list they
    // are dropped by default rather than by enumeration, which is the point —
    // this list is the old criterion kept as a REGRESSION pin, not as policy.
    const originScoped = [
      "set-cookie",
      "set-cookie2",
      "set-login",
      "strict-transport-security",
      "clear-site-data",
      "alt-svc",
      "accept-ch",
      "critical-ch",
      "origin-agent-cluster",
      "public-key-pins",
      "public-key-pins-report-only",
      "expect-ct",
      "report-to",
      "reporting-endpoints",
      "nel",
      "content-security-policy",
      "content-security-policy-report-only",
      "www-authenticate",
      "proxy-authenticate",
    ];
    const fromGuest = new Headers({ "content-type": "application/json" });
    for (const name of originScoped) fromGuest.set(name, "tenant-supplied");
    const returned = pickHeaders(fromGuest, GUEST_WEBHOOK_RESPONSE_HEADERS);
    expect([...returned.keys()]).toEqual(["content-type"]);
  });

  test("does not return a tenant guest's Set-Cookie", () => {
    // Kept on its own because it is the entry with a shipped defect behind it:
    // `NEVER_FORWARDED` strips the REQUEST-side `cookie` and the response half
    // had no entry anywhere, so a tenant guest set a cookie on the platform's
    // shared origin.
    const fromGuest = new Headers({ "content-type": "application/json" });
    fromGuest.append("set-cookie", "sid=tenant-owned; Path=/; HttpOnly");
    const returned = pickHeaders(fromGuest, GUEST_WEBHOOK_RESPONSE_HEADERS);
    expect(returned.get("set-cookie")).toBeNull();
    expect(returned.getSetCookie()).toEqual([]);
  });

  test("does not return a header nobody enumerated", () => {
    // The failing-first observation, kept as the argument for the SHAPE rather
    // than for any entry. All three cross the deny-list this replaced; all three
    // are dropped here without anyone having had to hear of them.
    const fromGuest = new Headers({ "content-type": "application/json" });
    fromGuest.set("refresh", "0; url=https://tenant.example/take-over");
    fromGuest.set("speculation-rules", '"/tenant-rules.json"');
    fromGuest.set("integrity-policy", "blocked-destinations=(script)");
    const returned = pickHeaders(fromGuest, GUEST_WEBHOOK_RESPONSE_HEADERS);
    expect([...returned.keys()]).toEqual(["content-type"]);
  });

  test("omits `location`, which is the decision this list makes", () => {
    // Recorded as an assertion rather than only in prose, because the cost is
    // real: a tenant answering a callback with a 302 loses it. Adding it back is
    // one entry, and the thing to refuse is adding it back while a BROWSER can
    // reach this hop — a relayed tenant redirect on the platform's own origin is
    // an open redirect. `Refresh` above is the same header under another name,
    // which is why excusing this one was untenable.
    expect([...GUEST_WEBHOOK_RESPONSE_HEADERS]).not.toContain("location");
    const fromGuest = new Headers({ location: "https://tenant.example/elsewhere" });
    expect(pickHeaders(fromGuest, GUEST_WEBHOOK_RESPONSE_HEADERS).get("location")).toBeNull();
  });
});
