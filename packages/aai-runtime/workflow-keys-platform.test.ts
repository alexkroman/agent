// Copyright 2026 the AAI authors. MIT license.
/**
 * What the platform key store puts ON the wire, and what it does with an answer
 * it cannot read.
 *
 * `workflow-keys-conformance.test.ts` runs the whole `WorkflowKeyStore` contract
 * over this client through a handler-shaped transport, and that is where its
 * SEMANTICS are asserted. This file is the other half — the questions a
 * conformance table cannot ask, because they are about a reply no correct route
 * produces or about a request field the interface does not mention:
 *
 * - the route, the bearer and the method envelope, which are what a rename breaks
 *   and which surface as a 404 that reads like a caller with no prior run;
 * - the `createdAt` this client STAMPS, since the interface takes no timestamp;
 * - a malformed 200, which the fake in the conformance file never produces (the
 *   same split `workflow-journal-platform.test.ts` records: there a correct
 *   answer's MEANING, here an answer that will not read).
 */

import { describe, expect, test } from "vitest";
import { PLATFORM_ROUTES } from "./platform-endpoint.ts";
import { createPlatformKeyStore } from "./workflow-keys-platform.ts";

/** One captured request. */
type Sent = { url: string; body: Record<string, unknown>; headers: Headers };

/**
 * A store whose transport records what crossed and answers `result`.
 *
 * `result` is a function of the request so a case can answer differently per
 * method; every case here needs only one answer, and taking a thunk is what keeps
 * the two-call cases (`record` then `lookup`) from needing two stores.
 */
function recordingStore(result: (body: Record<string, unknown>) => unknown) {
  const sent: Sent[] = [];
  const keys = createPlatformKeyStore({
    base: "https://platform.test/my-agent/",
    token: "sandbox-token",
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push({ url: String(url), body, headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ result: result(body) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { keys, sent };
}

/** A store whose transport answers one status with one body. */
function failingStore(status: number, message = "nope") {
  return createPlatformKeyStore({
    base: "https://platform.test/my-agent",
    token: "sandbox-token",
    fetch: async () => new Response(message, { status }),
  });
}

describe("what crosses the wire", () => {
  test("both methods POST the shared route with the sandbox bearer", async () => {
    // The route comes from `PLATFORM_ROUTES` on both sides — this client and
    // `aai-server/workflow-keys-handler.ts` — so this asserts the composition
    // rather than the string: a base with a trailing slash, the declared path,
    // and no second slash between them.
    const { keys, sent } = recordingStore(() => null);
    await keys.record("digest", "+14155550123", "wrun_1");
    await keys.lookup("digest", "+14155550123", 20);
    expect(sent).toHaveLength(2);
    for (const call of sent) {
      expect(call.url).toBe(`https://platform.test/my-agent${PLATFORM_ROUTES.workflowKeys}`);
      expect(call.headers.get("authorization")).toBe("Bearer sandbox-token");
    }
    expect(sent.map((call) => call.body.method)).toEqual(["record", "lookup"]);
  });

  test("record sends the run, the workflow, the key and a stamped createdAt", async () => {
    // `createdAt` is the one field the interface does not mention: `record` takes
    // three strings, so the CLIENT is what supplies the instant — deliberately,
    // because the ordering the index promises is "the order they were started" and
    // the engine is what started them. A `now()` in the statement would be a
    // second clock in it.
    const before = Date.now();
    const { keys, sent } = recordingStore(() => null);
    await keys.record("digest", "+14155550123", "wrun_1");
    const body = sent[0]?.body ?? {};
    expect(body).toMatchObject({
      method: "record",
      runId: "wrun_1",
      workflow: "digest",
      key: "+14155550123",
    });
    expect(typeof body.createdAt).toBe("number");
    expect(Number(body.createdAt)).toBeGreaterThanOrEqual(before);
    expect(Number.isInteger(body.createdAt)).toBe(true);
  });

  test("an EMPTY key crosses as an empty string, not as an absent field", async () => {
    // A withheld caller ID is an empty key, and the route reads it with a field
    // reader of its own for exactly this reason (`requiredString` refuses `""`).
    // What this pins is the CLIENT's half: `key` is present and empty rather than
    // dropped by the JSON, which is what would make the route answer 400.
    const { keys, sent } = recordingStore(() => null);
    await keys.record("digest", "", "wrun_1");
    expect(sent[0]?.body).toHaveProperty("key", "");
    expect("key" in (sent[0]?.body ?? {})).toBe(true);
  });

  test("lookup sends the limit it was given, unclamped", async () => {
    // `resolveFindLimit` clamps ABOVE this seam, and the route refuses anything
    // over its own ceiling — so a client that clamped again would be a second
    // policy able to disagree with both. What reaches here is passed through.
    const { keys, sent } = recordingStore(() => []);
    await keys.lookup("digest", "caller", 7);
    expect(sent[0]?.body).toMatchObject({ method: "lookup", workflow: "digest", key: "caller" });
    expect(sent[0]?.body.limit).toBe(7);
  });
});

describe("an answer this client cannot read", () => {
  test("lookup answers the run ids in the ORDER the platform sent them", async () => {
    // Newest-first is the platform's `order by`, and this side must not re-sort:
    // a client-side ordering rule would be a second one, able to disagree with the
    // one the other two backends implement. Asserted with ids whose lexical order
    // is the REVERSE of the sent order, so a sort of any kind fails here.
    const keys = recordingStore(() => ["wrun_a", "wrun_c", "wrun_b"]).keys;
    expect(await keys.lookup("digest", "caller", 20)).toEqual(["wrun_a", "wrun_c", "wrun_b"]);
  });

  test("a lookup answer that is not an array reads as no runs", async () => {
    // Lax on purpose, and only here: the caller is a lookup, so the honest answer
    // to "which runs belong to this caller" when the reply cannot be read is "none
    // I can name". Throwing would fail a `find` over a reply shape, and inventing
    // an entry would send `getRun` after a run id nothing can answer.
    for (const answer of [null, 42, "wrun_1", { runId: "wrun_1" }]) {
      const keys = recordingStore(() => answer).keys;
      expect(await keys.lookup("digest", "caller", 20)).toEqual([]);
    }
  });

  test("a non-string entry is dropped and its siblings still answer", async () => {
    // The half a blanket `[]` would lose. A row that will not read must not take
    // the page with it, for the reason the journal client's `listRuns` gives.
    const keys = recordingStore(() => ["wrun_1", 7, null, "wrun_2"]).keys;
    expect(await keys.lookup("digest", "caller", 20)).toEqual(["wrun_1", "wrun_2"]);
  });

  test("a 200 with no result envelope is a failure, not an empty page", async () => {
    // `platformResult`'s rule, and it matters most here: `[]` is a legitimate
    // answer on this route, so a contract change would otherwise arrive as "this
    // caller has no runs" — which is the confusion the whole platform arm exists
    // to end.
    const keys = createPlatformKeyStore({
      base: "https://platform.test/my-agent",
      token: "t",
      fetch: async () => new Response("{}", { status: 200 }),
    });
    await expect(keys.lookup("digest", "caller", 20)).rejects.toThrow(/without a result/);
  });
});

describe("a platform that refuses", () => {
  test.each([
    ["501, no platform journal on this deployment", 501],
    ["503, the platform is unavailable", 503],
    ["400, a body this client built wrongly", 400],
  ])("propagates %s rather than answering an empty page", async (_label, status) => {
    // **A 501 is not special, and that is the decision.** The backend was chosen
    // ONCE, from whether the boot env named a platform, so there is nothing per
    // request to re-decide — and silently becoming memory on a status is the
    // failure this store exists to end. Every status therefore reaches the caller,
    // which for `lookup` fails the `find` and for `record` is caught and warned by
    // `WorkflowClient.start`.
    const keys = failingStore(status);
    await expect(keys.lookup("digest", "caller", 20)).rejects.toThrow(
      new RegExp(`answered HTTP ${status}`),
    );
    await expect(keys.record("digest", "caller", "wrun_1")).rejects.toThrow(
      new RegExp(`answered HTTP ${status}`),
    );
  });

  test("the error NAMES the method, so a log line says which call failed", async () => {
    const keys = failingStore(500, "boom");
    await expect(keys.lookup("digest", "caller", 20)).rejects.toThrow(/workflow-keys lookup/);
    await expect(keys.record("digest", "caller", "wrun_1")).rejects.toThrow(/workflow-keys record/);
  });
});
