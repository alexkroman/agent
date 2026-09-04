// Copyright 2026 the AAI authors. MIT license.
/**
 * The platform journal's own decisions, over a fake transport.
 *
 * What is NOT here is whether the platform stores any of this correctly — that is
 * `aai-server/workflow-journal.scenario.test.ts`, against a real database. This
 * file covers the half that lives on THIS side of the wire and is silent when
 * wrong:
 *
 * - the CODEC runs here, so a `Uint8Array` in a step's output survives a round
 *   trip and the platform never sees a decoded value;
 * - an answer is REFUSED rather than invented, each refusal protecting a
 *   property the engine cannot re-derive — and the refusal has to be REACHABLE,
 *   which is a separate claim: `appendStep`'s guard could only ever fire on
 *   `null` while the parse below it accepted any record;
 * - `wakeSleeps` sends the ENGINE's clock, because a second clock in that
 *   comparison is a second source of truth for replay determinism.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import { createPlatformJournal } from "./workflow-journal-platform.ts";
import type { StepEntry } from "./workflow-journal-types.ts";
import { isResumableJournal } from "./workflow-journal-types.ts";

/** One call the journal made. */
type Sent = { method: string; body: Record<string, unknown> };

/**
 * A journal over a fake transport, answering `results` in order.
 *
 * The `fetch` seam is `PlatformEndpoint`'s own, so this exercises the real
 * `platformResult` — the envelope, the status handling and the `{ result }`
 * unwrapping are all production code rather than a fake's approximation.
 */
function journalOver(results: unknown[]) {
  const sent: Sent[] = [];
  const calls: RequestInit[] = [];
  const urls: string[] = [];
  const queue = [...results];
  // Typed as the seam declares it, so no cast is needed at any call site — the
  // `as unknown as typeof fetch` this replaced is the pattern the escape-hatch
  // ratchet counts, and it also stops reporting the moment the seam's shape moves.
  const fetchFn: typeof globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    calls.push(init ?? {});
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ method: String(body.method), body });
    return new Response(JSON.stringify({ result: queue.shift() ?? null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const journal = createPlatformJournal({
    base: "https://platform.test/digest-desk",
    token: "sandbox-token",
    fetch: fetchFn,
  });
  return { journal, sent, calls, urls };
}

describe("the codec runs on this side", () => {
  test("a Uint8Array in a step's output crosses as an ENVELOPE, not an index map", async () => {
    // `JSON.stringify` turns one into `{"0":1,"1":2}` with NO error, so a step
    // that returns bytes would silently come back as an object with numeric keys.
    // The envelope is what stops that, and it has to be written on this side —
    // the platform stores the text into `jsonb` without interpreting it, so it
    // cannot revive what it did not write.
    const entry: StepEntry = {
      key: "fetch#0",
      name: "fetch",
      status: "ok",
      output: new Uint8Array([1, 2, 3]),
      attempts: 1,
      finishedAt: 7,
    };
    const { journal, sent } = journalOver([]);
    await journal.appendStep("wrun_1", entry).catch(() => undefined);
    const outbound = sent[0]?.body.entry;
    const output = isRecord(outbound) ? outbound.output : undefined;
    expect(typeof output).toBe("string");
    expect(String(output)).toContain("Uint8Array");
  });

  test("an absent value stays absent rather than becoming null", async () => {
    // `undefined` and `null` are different answers: a run with no input is not a
    // run whose input is null, and the difference reaches an author's schema.
    const { journal, sent } = journalOver([null]);
    await journal.createRun({
      runId: "wrun_1",
      workflow: "digest",
      status: "pending",
      createdAt: 1,
      input: undefined,
    });
    expect(sent[0]?.body).not.toHaveProperty("input", null);
  });

  test("decodes a stored envelope back into the author's value", async () => {
    const { journal } = journalOver([
      {
        runId: "wrun_1",
        workflow: "digest",
        status: "completed",
        createdAt: 5,
        input: JSON.stringify({ topic: "otters" }),
        output: null,
        error: null,
      },
    ]);
    const run = await journal.getRun("wrun_1");
    expect(run?.input).toEqual({ topic: "otters" });
    expect(run?.output).toBeUndefined();
  });
});

describe("an answer is refused rather than invented", () => {
  test("claimAttempt on a non-number, because a made-up ceiling does not hold", async () => {
    // The attempt ledger's whole job is that a wedged step reaches its ceiling.
    // A default here would be a ceiling that never arrives.
    const { journal } = journalOver([null]);
    await expect(journal.claimAttempt("wrun_1", "a#0", "w", 1000)).rejects.toThrow(
      /claimAttempt answered/,
    );
  });

  test("appendStep on an unreadable answer, because the STORED entry is the one that counts", async () => {
    // A double execution is deterministic only if both walks return the FIRST
    // stored entry. Falling back to the entry we sent would return the second
    // execution's own result and diverge.
    const { journal } = journalOver([null]);
    await expect(
      journal.appendStep("wrun_1", {
        key: "a#0",
        name: "a",
        status: "ok",
        attempts: 1,
        finishedAt: 1,
      }),
    ).rejects.toThrow(/appendStep answered nothing/);
  });

  test("appendStep on a step-shaped answer that is not a step", async () => {
    // The guard above could only ever fire on `null`: `toStep` accepted ANY
    // record, so `{ ok: true }` became `key: "undefined", attempts: NaN` and the
    // engine adopted it as the authoritative entry — `output: undefined`, so a
    // replay returned nothing where the step had returned a value. That is
    // exactly the divergence the refusal exists to prevent, reached by a route
    // the refusal could not see.
    const { journal } = journalOver([{ ok: true }]);
    await expect(
      journal.appendStep("wrun_1", {
        key: "a#0",
        name: "a",
        status: "ok",
        attempts: 1,
        finishedAt: 1,
      }),
    ).rejects.toThrow(/appendStep answered nothing/);
  });

  test("a malformed step in readSteps is dropped, like a malformed run in a listing", async () => {
    const { journal } = journalOver([
      [
        { key: "a#0", name: "a", status: "ok", attempts: 1, finishedAt: 1 },
        { key: "b#0", name: "b", status: "maybe", attempts: 1, finishedAt: 2 },
      ],
    ]);
    expect((await journal.readSteps("wrun_1")).map((step) => step.key)).toEqual(["a#0"]);
  });

  test("claimSleep on an unreadable answer, so a deadline is never guessed", async () => {
    const { journal } = journalOver([null]);
    await expect(journal.claimSleep("wrun_1", "sleep!0", 1, undefined)).rejects.toThrow(
      /claimSleep answered nothing/,
    );
  });

  test("a run whose STATUS is not one of the five reads as absent", async () => {
    // Checked rather than cast. An unknown status put into the engine's `expect`
    // comparisons matches nothing, and the run stops advancing with no error.
    const { journal } = journalOver([
      { runId: "wrun_1", workflow: "digest", status: "sleeping", createdAt: 1 },
    ]);
    expect(await journal.getRun("wrun_1")).toBeUndefined();
  });

  test("a malformed row in a LISTING is dropped, not fatal", async () => {
    // The caller is a page. One bad row must not fail it.
    const { journal } = journalOver([
      [
        { runId: "wrun_1", workflow: "digest", status: "completed", createdAt: 1 },
        { runId: "wrun_2", workflow: "digest", status: "not-a-status", createdAt: 2 },
      ],
    ]);
    const runs = await journal.listRuns("digest", 10);
    expect(runs.map((run) => run.runId)).toEqual(["wrun_1"]);
  });
});

describe("wakeSleeps", () => {
  test("sends the ENGINE's clock, never leaving the comparison to the database", async () => {
    // A second clock in this comparison is a second source of truth for the one
    // value replay determinism rests on.
    const before = Date.now();
    const { journal, sent } = journalOver([2]);
    expect(await journal.wakeSleeps("wrun_1", undefined)).toBe(2);
    const now = Number(sent[0]?.body.now);
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  test("answers 0 rather than NaN when the platform says something else", async () => {
    // `{ woken: 0 }` is an answer a caller acts on; NaN is one it cannot.
    const { journal } = journalOver(["two"]);
    expect(await journal.wakeSleeps("wrun_1", undefined)).toBe(0);
  });
});

describe("the wire", () => {
  test("posts to the journal route carrying the per-sandbox bearer", async () => {
    // The bearer is the whole authorization on this route, and the path is half
    // of one wire — a literal on either side is a rename away from a 404 the
    // runtime can only report as `answered HTTP 404`.
    const { journal, urls, calls } = journalOver([null]);
    await journal.closeHook("wrun_1", "hook!0");
    expect(urls[0]).toContain("/workflow-journal");
    const headers = calls[0]?.headers;
    expect(JSON.stringify(headers)).toContain("sandbox-token");
  });
});

describe("resumableRuns is deliberately NOT declared here", () => {
  test("the platform backend cannot be swept, because the queue reconcile owns that", async () => {
    // The ABSENCE pin, and it is a claim rather than a gap: a deployed guest's
    // schedule is a delayed message in the platform's queue, and a message that
    // goes missing is re-enqueued by `aai-server/workflow-queue-reconcile.ts`.
    // A boot sweep here would be a second recovery mechanism racing it — one
    // sandbox boot per copy of this package per boot — so
    // `createInProcessWorkflowEngine` skips the sweep whenever a dispatcher was
    // injected, which is exactly when this backend is in play.
    //
    // Stated as a test because the alternative is a comment: the method is
    // OPTIONAL, so adding it here would compile, pass every existing suite, and
    // change what a deployed guest does at boot.
    const { journal } = journalOver([null]);
    expect(journal.resumableRuns).toBeUndefined();
    expect(isResumableJournal(journal)).toBe(false);
  });
});
