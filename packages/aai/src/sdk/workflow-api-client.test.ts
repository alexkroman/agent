// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the workflow API client.
 *
 * `fetch` is stubbed rather than a server started: what these assert is the
 * REQUEST this client builds (its method, its path, its query, its bearer, its
 * deadline) and what it makes of the answer — the two halves every caller
 * depends on and the two that can silently disagree with `host/workflow-api.ts`.
 *
 * They came from `aai-ui/workflow-client.test.ts` with the implementation, which
 * is the point: three packages shared one client and only one of them had this
 * coverage, so the CLI and the studio each carried a subset nothing pinned.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { createWorkflowApiClient, WORKFLOW_API_PREFIX } from "./workflow-api-client.ts";
import { MAX_WORKFLOW_WAIT_MS, type WorkflowRunSnapshot } from "./workflow-run.ts";

const BASE = "https://agents.example/my-agent/";

function client(over: { token?: string; timeoutMs?: number } = {}) {
  return createWorkflowApiClient({ baseUrl: BASE, ...over });
}

function run(over: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    runId: "wrun_1",
    workflow: "digest",
    createdAt: 0,
    status: "running",
    ...over,
  } as WorkflowRunSnapshot;
}

/** A JSON response, as `fetch` resolves one. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

/** The URL and init of the nth request this client made. */
function call(n = 0): [string, RequestInit | undefined] {
  return fetchMock.mock.calls[n] as [string, RequestInit | undefined];
}

describe("createWorkflowApiClient", () => {
  test("resolves every path under the agent's own base URL", async () => {
    fetchMock.mockImplementation(async () => json({ workflows: [{ name: "digest" }] }));
    await client().list();
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows");
  });

  test("a base URL with no trailing slash resolves the same way", async () => {
    // One resolver rather than a trailing-slash rule per call site — two of those
    // is how the three copies this replaced drifted.
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await createWorkflowApiClient({ baseUrl: "https://agents.example/my-agent" }).list();
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows");
  });

  test("the prefix is joined RELATIVELY, so a deployed agent's own path survives", async () => {
    // `new URL("/workflows", base)` is absolute and would drop the slug segment,
    // turning every request for a deployed agent into one for the platform root.
    expect(WORKFLOW_API_PREFIX.startsWith("/")).toBe(true);
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await createWorkflowApiClient({ baseUrl: "https://platform.example/some-slug" }).list();
    expect(new URL(call()[0]).pathname).toBe("/some-slug/workflows");
  });

  test("a token rides every request as a bearer", async () => {
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await client({ token: "s3cret" }).list();
    expect(call()[1]?.headers).toMatchObject({ Authorization: "Bearer s3cret" });
  });

  test("no token means no authorization header at all", async () => {
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await client().list();
    expect(call()[1]?.headers).toEqual({});
  });

  test("start posts the workflow, the input and the key, and resolves the run id", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_9" }, 202));
    const id = await client().start("digest", { topic: "ai" }, { key: "caller-1" });
    expect(id).toBe("wrun_9");
    const [url, init] = call();
    expect(url).toBe("https://agents.example/my-agent/workflows/runs");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      workflow: "digest",
      input: { topic: "ai" },
      key: "caller-1",
    });
  });

  test("start omits `input`, `key` and `wait` entirely when they were not given", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_9" }, 202));
    await client().start("digest");
    expect(JSON.parse(String(call()[1]?.body))).toEqual({ workflow: "digest" });
  });

  test("a failure carries the SERVER'S sentence, not the status", async () => {
    // That text is the whole diagnostic: an unknown workflow names the declared
    // ones, a bad input names the schema issues.
    fetchMock.mockImplementation(async () =>
      json({ error: 'Workflow "nope" is not declared' }, 400),
    );
    await expect(client().start("nope")).rejects.toThrow('Workflow "nope" is not declared');
  });

  test("a failure that is not our JSON shape degrades to the status, NAMED", async () => {
    // What a proxy or gateway in front of the agent produces. The label appears
    // only here — prefixing the agent's own sentence would put our words in
    // front of the ones worth reading.
    fetchMock.mockImplementation(async () => new Response("<html>502</html>", { status: 502 }));
    await expect(client().list()).rejects.toThrow("Workflow API 502");
  });

  test("get resolves UNDEFINED for a 404 — an answer, not a failure", async () => {
    fetchMock.mockImplementation(async () => json({ error: "No workflow run with id gone" }, 404));
    await expect(client().get("gone")).resolves.toBeUndefined();
  });

  test("find sends the key; recent sends none", async () => {
    fetchMock.mockImplementation(async () => json({ runs: [] }));
    const api = client();
    await api.find("digest", "caller-1", { limit: 3 });
    await api.recent("digest");
    expect(call(0)[0]).toContain("workflow=digest&key=caller-1&limit=3");
    expect(call(1)[0]).toContain("workflow=digest");
    expect(call(1)[0]).not.toContain("key=");
  });

  test("a limit that was not asked for is not encoded", async () => {
    fetchMock.mockImplementation(async () => json({ runs: [] }));
    await client().recent("digest");
    expect(call()[0]).not.toContain("limit=");
  });

  test("a body answering without `runs` reads as an empty list", async () => {
    fetchMock.mockImplementation(async () => json({}));
    await expect(client().recent("digest")).resolves.toEqual([]);
  });

  test("a body answering without `workflows` reads as an empty list", async () => {
    fetchMock.mockImplementation(async () => json({}));
    await expect(client().list()).resolves.toEqual([]);
  });

  test("cancel is a DELETE and reports whether THIS call ended the run", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_1", cancelled: false }));
    const cancelled = await client().cancel("wrun_1");
    expect(cancelled).toBe(false);
    expect(call()[1]?.method).toBe("DELETE");
  });

  test("a run id is percent-encoded into every path", async () => {
    fetchMock.mockImplementation(async () => json(run()));
    await client().get("a/b");
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows/runs/a%2Fb");
  });

  test("watch asks for an event stream and returns the raw response", async () => {
    // Raw, because what a caller decides first is whether the agent serves this
    // at all — an older deploy answers 404 and it falls back to polling.
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
    const res = await client().watch("wrun_1");
    expect(res.status).toBe(404);
    expect(call()[0]).toContain("/workflows/runs/wrun_1/events");
    expect(call()[1]?.headers).toMatchObject({ Accept: "text/event-stream" });
  });

  test("streamOutput asks for the run's own chunks, raw like watch", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
    const res = await client().streamOutput("wrun_1");
    expect(res.status).toBe(404);
    // No query at all when nothing was asked for — the whole stream from 0.
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows/runs/wrun_1/stream");
    expect(call()[1]?.headers).toMatchObject({ Accept: "text/event-stream" });
  });

  test("streamOutput carries namespace and startIndex, negative included", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    await client().streamOutput("wrun_1", { namespace: "progress", startIndex: -3 });
    expect(call()[0]).toContain("namespace=progress");
    expect(call()[0]).toContain("startIndex=-3");
  });

  test("streamOutput encodes a startIndex of 0 rather than dropping it", async () => {
    // `omitUndefined` over a pre-stringified value rather than the number, so
    // the falsy-but-meaningful `0` survives.
    //
    // What this claims is about SERIALIZATION and nothing else, which is worth
    // saying because the name it used to carry ("which is not absent") read as a
    // claim about the protocol. It is not one: `startIndex` is an INCLUSIVE
    // floor, so a `0` and an absent parameter are the same request and this test
    // would pass either way. It was cited as proof that a `0` is deliberately
    // sent — i.e. as proof the cursor semantic was settled — while the store read
    // that `0` exclusively and answered it with the run's first chunk missing.
    // The semantic is asserted in
    // `packages/aai-runtime/src/workflow-stream-cursor.test.ts`; a URL cannot state
    // it.
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    await client().streamOutput("wrun_1", { startIndex: 0 });
    expect(call()[0]).toContain("startIndex=0");
  });

  test("streamOutput forwards an abort signal", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    const controller = new AbortController();
    await client().streamOutput("wrun_1", { signal: controller.signal });
    expect(call()[1]?.signal).toBe(controller.signal);
  });

  test("wake is a POST reporting how many sleeps it ended", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_1", woken: 2 }));
    const woken = await client().wake("wrun_1");
    expect(woken).toBe(2);
    expect(call()[1]?.method).toBe("POST");
    expect(call()[0]).toContain("/workflows/runs/wrun_1/wake");
  });

  /**
   * The FAILING observation: `POST /runs/:id/wake` reads a repeatable
   * `?correlationId=`, and nothing in the repo could send one — `wake(runId)`
   * took no options at all. That made a TARGETED wake unreachable over this
   * client, and with it the only spelling that can end a hook's approval
   * deadline: a BARE wake deliberately cannot reach a `kind: "hookTimeout"`
   * (the journal filters it), so the deadline had no reachable request.
   */
  test("wake sends each correlation id as a repeated query parameter", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_1", woken: 1 }));
    await client().wake("wrun_1", { correlationIds: ["review", "audit"] });
    expect(call()[0]).toBe(
      "https://agents.example/my-agent/workflows/runs/wrun_1/wake?correlationId=review&correlationId=audit",
    );
  });

  test("wake sends no query at all for a bare call", async () => {
    // The absence is the request: a bare wake is the blunt "send it now" button,
    // and `?correlationId=` (blank) is a 400 on the route rather than a synonym
    // for it — so an empty list must not become one either.
    fetchMock.mockImplementation(async () => json({ runId: "wrun_1", woken: 1 }));
    const api = client();
    await api.wake("wrun_1");
    await api.wake("wrun_1", { correlationIds: [] });
    expect(call(0)[0]).not.toContain("?");
    expect(call(1)[0]).not.toContain("?");
  });

  test.each([
    ["blank", ""],
    ["whitespace", "   "],
  ])("wake refuses a %s correlation id before sending anything", async (_label, id) => {
    // The route answers 400 for exactly this, because the journal is explicit
    // that an empty-string id is not an absent one — two backends used to fold
    // them and woke every uncorrelated sleep on the run. A client that can
    // construct a request the server will refuse is one that should refuse first.
    await expect(client().wake("wrun_1", { correlationIds: [id] })).rejects.toThrow(
      /must not be empty/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("wake refuses a correlation id past the route's length cap", async () => {
    const api = client();
    // The exact boundary in both directions, so the refusal cannot drift a
    // character away from the 400 the route answers.
    await expect(api.wake("wrun_1", { correlationIds: ["a".repeat(257)] })).rejects.toThrow(
      /at most 256 characters/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementation(async () => json({ runId: "wrun_1", woken: 1 }));
    await expect(api.wake("wrun_1", { correlationIds: ["a".repeat(256)] })).resolves.toBe(1);
  });

  test("wake resolves 0 for a 404 — nothing was sleeping, which is an answer", async () => {
    fetchMock.mockImplementation(async () => json({ error: "gone" }, 404));
    await expect(client().wake("gone")).resolves.toBe(0);
  });

  test("wake reads 0 from a body that answered without `woken`", async () => {
    // An older agent, or a proxy that rewrote the body: absent is not 'many'.
    fetchMock.mockImplementation(async () => json({ runId: "wrun_1" }));
    await expect(client().wake("wrun_1")).resolves.toBe(0);
  });

  test("wake surfaces a real failure rather than reporting 0", async () => {
    // The one case that must NOT degrade to an answer: 0 means "not sleeping",
    // and reporting it for a 500 would hide a broken agent behind a normal reply.
    fetchMock.mockImplementation(async () => json({ error: "boom" }, 500));
    await expect(client().wake("wrun_1")).rejects.toThrow("boom");
  });

  test("watch passes the caller's abort signal and sends none without one", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    const controller = new AbortController();
    const api = client();
    await api.watch("wrun_1", controller.signal);
    await api.watch("wrun_2");
    expect(call(0)[1]?.signal).toBe(controller.signal);
    expect(call(1)[1]).not.toHaveProperty("signal");
  });
});

describe("startAndWait", () => {
  test("asks the agent to hold the request open and resolves the finished run", async () => {
    fetchMock.mockImplementation(async () =>
      json({ runId: "wrun_9", run: run({ runId: "wrun_9", status: "completed", output: 3 }) }),
    );

    const finished = await client().startAndWait("digest", { url: "u" });

    const body = JSON.parse(String(call()[1]?.body)) as { workflow: string; wait: number };
    expect(body.workflow).toBe("digest");
    expect(body.wait).toBeGreaterThan(0);
    expect(finished).toMatchObject({ status: "completed", output: 3 });
  });

  test("clamps a wait past the cap, so it cannot outlast what the agent will hold", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_9", run: run() }));
    await client().startAndWait("digest", undefined, { wait: 10 * 60_000 });
    const body = JSON.parse(String(call()[1]?.body)) as { wait: number };
    expect(body.wait).toBe(MAX_WORKFLOW_WAIT_MS);
  });

  test("resolves a still-running run rather than failing when the wait ran out", async () => {
    // The agent answers 202 with the running snapshot; that is an answer, and a
    // caller checks `isTerminal` rather than assuming.
    fetchMock.mockImplementation(async () => json({ runId: "wrun_9", run: run() }, 202));
    const started = await client().startAndWait("digest");
    expect(started).toMatchObject({ runId: "wrun_1", status: "running" });
  });

  test("still reports the run id when the answer carried no snapshot", async () => {
    // A proxy that rewrote the body, or a replica that has not yet seen its own
    // write. The caller has the id, which is what a watch needs; saying `pending`
    // is both true and useful — and it costs no second request.
    fetchMock.mockImplementation(async () => json({ runId: "wrun_9" }, 202));

    const started = await client().startAndWait("digest");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(started).toMatchObject({ runId: "wrun_9", status: "pending" });
  });

  test("a rejected input rejects with the agent's own sentence", async () => {
    fetchMock.mockImplementation(async () => json({ error: "url: invalid" }, 400));
    await expect(client().startAndWait("digest")).rejects.toThrow(/url: invalid/);
  });
});

describe("get with a wait", () => {
  test("puts the budget on the query", async () => {
    fetchMock.mockImplementation(async () => json(run({ status: "completed" })));
    await client().get("wrun_1", { wait: 5000 });
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows/runs/wrun_1?wait=5000");
  });

  test("sends no query at all without one", async () => {
    fetchMock.mockImplementation(async () => json(run()));
    await client().get("wrun_1");
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows/runs/wrun_1");
  });
});

/**
 * The deadline, which is the one thing no copy of this client had and one caller
 * (the studio's card) had hand-rolled around every fetch.
 *
 * A hung request is not a failure — `fetch` carries no timeout of its own, so it
 * never settles and no error path, retry or backoff ever runs.
 */
describe("timeoutMs", () => {
  test("no deadline at all when it was not asked for", async () => {
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await client().list();
    expect(call()[1]).not.toHaveProperty("signal");
  });

  test("arms one on an ordinary read", async () => {
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await client({ timeoutMs: 20_000 }).list();
    expect(call()[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("both waiting paths get the agent's own budget ON TOP of it", async () => {
    // Otherwise a 20s client deadline cuts a 60s wait in the middle and reports
    // a network error for a run that is perfectly healthy — losing the one thing
    // the caller cannot rebuild.
    //
    // The DURATION is asserted through the factory rather than by advancing a
    // clock: `AbortSignal.timeout` is a platform timer, so `vi.useFakeTimers`
    // does not drive it and a signal that never fires reads as a pass.
    const timeout = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockImplementation(async () => json(run()));
    const api = client({ timeoutMs: 20_000 });

    await api.get("wrun_1", { wait: MAX_WORKFLOW_WAIT_MS });
    await api.startAndWait("digest");

    // Every request either path made — the floor is what keeps the assertion
    // below from passing vacuously on an empty call list.
    expect(timeout.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(timeout.mock.calls.flat()).toEqual(
      timeout.mock.calls.map(() => 20_000 + MAX_WORKFLOW_WAIT_MS),
    );
  });

  test("both event streams are EXEMPT — a healthy one stays open indefinitely", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    const api = client({ timeoutMs: 20_000 });
    await api.watch("wrun_1");
    await api.streamOutput("wrun_1");
    expect(call(0)[1]).not.toHaveProperty("signal");
    expect(call(1)[1]).not.toHaveProperty("signal");
  });
});

describe("a 2xx that is not JSON", () => {
  /**
   * The status does not decide whether a body is JSON. A proxy, a CDN or a
   * platform broker answering while a sandbox boots all reply `200 text/html`,
   * and `res.json()` rejected with a bare `SyntaxError` — no status, no label,
   * and for `POST /runs` no `runId` for a run the agent may already have
   * created, which is the one thing on this surface a caller cannot rebuild.
   */
  const html = () =>
    new Response("<html><body>502 Bad Gateway</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });

  test.each([
    ["list", (api: ReturnType<typeof client>) => api.list()],
    ["start", (api: ReturnType<typeof client>) => api.start("digest")],
    ["startAndWait", (api: ReturnType<typeof client>) => api.startAndWait("digest")],
    ["get", (api: ReturnType<typeof client>) => api.get("wrun_1")],
    ["find", (api: ReturnType<typeof client>) => api.find("digest", "k")],
    ["recent", (api: ReturnType<typeof client>) => api.recent("digest")],
    ["cancel", (api: ReturnType<typeof client>) => api.cancel("wrun_1")],
    ["wake", (api: ReturnType<typeof client>) => api.wake("wrun_1")],
    ["upload", (api: ReturnType<typeof client>) => api.upload("bytes", { name: "a.txt" })],
  ])("%s reports the surface, the status and a preview — not a SyntaxError", async (_name, run) => {
    fetchMock.mockImplementation(async () => html());
    await expect(run(client())).rejects.toThrow(
      "Workflow API 200: <html><body>502 Bad Gateway</body></html>",
    );
  });

  test("an empty 2xx body is the bare labelled status", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 200 }));
    await expect(client().list()).rejects.toThrow("Workflow API 200");
  });

  test("a long body is capped and marked, so a whole page cannot reach a toast", async () => {
    fetchMock.mockImplementation(async () => new Response("z".repeat(5000), { status: 200 }));
    await expect(client().list()).rejects.toThrow(`Workflow API 200: ${"z".repeat(200)}…`);
  });

  test("a NON-2xx still reports the agent's own sentence, unchanged", async () => {
    // The guard above must not shadow the failure path: `{ error }` is the whole
    // diagnostic and it is what a caller sees.
    fetchMock.mockImplementation(async () => json({ error: "No workflow named digest" }, 400));
    await expect(client().start("digest")).rejects.toThrow("No workflow named digest");
  });
});

describe("streamed uploads", () => {
  test("PUTs to the caller's own id", async () => {
    fetchMock.mockImplementation(async () =>
      json({ id: "abc", name: "a.wav", type: "audio/wav", size: 2, complete: true }, 201),
    );
    const ref = await client().uploadStream("abc", "hi", { name: "a.wav" });
    expect(call()[0]).toBe(`${BASE}workflows/uploads/abc?name=a.wav`);
    expect(call()[1]?.method).toBe("PUT");
    expect(ref).toMatchObject({ id: "abc", complete: true });
    // Built from THIS client's base, never from the `url` the agent answered with.
    expect(ref.url).toBe(`${BASE}workflows/uploads/abc`);
  });

  test("an id needing escaping is escaped, not concatenated", async () => {
    fetchMock.mockImplementation(async () =>
      json({ id: "a/b", name: "", type: "", size: 0, complete: true }, 201),
    );
    await client().uploadStream("a/b", "hi");
    expect(call()[0]).toContain("workflows/uploads/a%2Fb?");
  });

  test("a 409 on a taken id reports the agent's own sentence", async () => {
    fetchMock.mockImplementation(async () => json({ error: "upload abc already exists" }, 409));
    await expect(client().uploadStream("abc", "hi")).rejects.toThrow("upload abc already exists");
  });

  test("downloads an upload's bytes as a Blob a page can play", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/wav" } }),
    );

    const blob = await client({ token: "tok" }).download("abc");

    expect(call()[0]).toBe(`${BASE}workflows/uploads/abc`);
    expect(blob.size).toBe(3);
    // The header is exactly why this is a Blob rather than a URL — see the
    // method's own doc: neither `<audio src>` nor `<a href>` can send one.
    const headers = call()[1]?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer tok");
  });

  test("a failed download reports the agent's own sentence", async () => {
    fetchMock.mockImplementation(async () => json({ error: "no upload with id abc" }, 404));

    await expect(client().download("abc")).rejects.toThrow("no upload with id abc");
  });

  test("reads an upload's record, including how much has arrived", async () => {
    fetchMock.mockImplementation(async () =>
      json({ id: "abc", name: "a.wav", type: "audio/wav", size: 512, complete: false }),
    );
    await expect(client().uploadInfo("abc")).resolves.toMatchObject({
      size: 512,
      complete: false,
    });
    expect(call()[0]).toBe(`${BASE}workflows/uploads/abc/info`);
  });
});
