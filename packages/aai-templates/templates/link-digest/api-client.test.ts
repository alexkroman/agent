// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the script-side client — the half of a workflow app that is an HTTP
 * API rather than a page.
 *
 * `agent.test.ts` drives the run; this drives what a CALLER sees of it, and the
 * seam is different in a way worth stating once. A step's HTTP goes through the
 * published `stepFetch` slot, which is why every spec in the file next door
 * reaches for `installStubStepFetch`. Nothing here is inside a step: the
 * workflow API client is ordinary browser-and-Node code over the global
 * `fetch`, so this file stubs THAT — and stubbing the wrong one of the two is
 * the mistake, in either direction, since each passes while exercising a path
 * the code under test never takes.
 *
 * The fake below answers routes rather than call counts: `apiRoot` joins
 * `/workflows` onto the base URL, so the paths here are the ones a deployed
 * agent really serves and a typo in either half fails rather than matching
 * whatever came next.
 */

import { expect, onTestFinished, test, vi } from "vitest";
import { connect, digestLink, pastDigests } from "./api-client.ts";

const BASE = "https://agents.example/link-digest";
const RUN_ID = "wrun_otters";

/** A completed run as the API serves it — the shape `WorkflowRunOf` describes. */
const COMPLETED = {
  runId: RUN_ID,
  workflow: "digest",
  status: "completed",
  createdAt: 1,
  output: {
    url: "https://example.com/otters",
    headline: "Otters use stones",
    points: ["They do."],
    filedAt: "2026-01-01T00:00:00.000Z",
  },
};

/** One SSE frame, in the wire format `readEventStream` parses inside `follow`. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * A deployed Link Digest, as far as `fetch` is concerned.
 *
 * `page` is a parameter because the one thing {@link connect} exists to catch is
 * a base URL pointing at a VOICE agent, and that case is only reachable by
 * answering `client-config` differently.
 */
function stubAgent(options: { page?: string; runs?: unknown[]; events?: string } = {}) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    if (url === `${BASE}/client-config`) {
      return Response.json({ name: "Link Digest", page: options.page ?? "static" });
    }
    if (url === `${BASE}/workflows/runs` && method === "POST") {
      return Response.json({ runId: RUN_ID });
    }
    if (url === `${BASE}/workflows/runs/${RUN_ID}/events`) {
      return new Response(options.events ?? frame("run", COMPLETED), {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    if (url.startsWith(`${BASE}/workflows/runs?`)) {
      return Response.json({ runs: options.runs ?? [] });
    }
    return Response.json({ error: `no route for ${method} ${url}` }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchStub);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return calls;
}

test("connect reads the agent's own description before anything else", async () => {
  const calls = stubAgent();
  const agent = await connect({ baseUrl: BASE });

  expect(calls[0]).toMatchObject({ method: "GET", url: `${BASE}/client-config` });
  // The normalized base is on the client, which is what the error messages quote
  // — a caller should never have to keep the string it was built from.
  expect(agent.baseUrl).toBe(BASE);
});

test("connect refuses a base URL pointing at a VOICE agent, naming it", async () => {
  // The mistake a script actually makes. Without this read it surfaces three
  // calls later as a 404 from a route that was never going to exist.
  stubAgent({ page: "voice" });
  await expect(connect({ baseUrl: `${BASE}/` })).rejects.toThrow(
    /agents\.example\/link-digest answers as a voice agent/,
  );
});

test("connect drops a trailing slash rather than asking for //client-config", async () => {
  // A platform routing `/:slug/client-config` answers the doubled path with a
  // 404, so the normalization is load-bearing rather than cosmetic.
  const calls = stubAgent();
  await connect({ baseUrl: `${BASE}/` });
  expect(calls[0]?.url).toBe(`${BASE}/client-config`);
});

test("digestLink starts the run under the caller's key and follows it to the end", async () => {
  const calls = stubAgent();
  const agent = await connect({ baseUrl: BASE });

  const run = await digestLink(agent, "https://example.com/otters", "nightly-job");

  expect(run.status).toBe("completed");
  // The whole reason the return type is `TerminalWorkflowRun`: `output` is
  // reachable off a completed run with no second narrowing, and it is TYPED by
  // the declaration rather than `unknown`.
  if (run.status !== "completed") expect.fail("a completed run must narrow to its output");
  expect(run.output.headline).toBe("Otters use stones");
  expect(run.output.filedAt).toBeTruthy();

  const started = calls.find((call) => call.method === "POST");
  expect(started?.body).toEqual({
    workflow: "digest",
    input: { url: "https://example.com/otters" },
    key: "nightly-job",
  });
});

test("digestLink sends NO key when the caller named none", async () => {
  // `omitUndefined` rather than `{ key: undefined }`: the request body is what
  // the agent indexes the run under, and a null key is not the same as no key.
  const calls = stubAgent();
  const agent = await connect({ baseUrl: BASE });
  await digestLink(agent, "https://example.com/otters");

  const started = calls.find((call) => call.method === "POST");
  expect(started?.body).not.toHaveProperty("key");
});

test("digestLink refuses to answer for a run the agent never knew", async () => {
  // `follow` ends having yielded nothing rather than throwing, so without this
  // check the function would resolve `undefined` typed as a settled run — the
  // one failure a caller would act on wrongly.
  stubAgent({ events: frame("missing", {}) });
  const agent = await connect({ baseUrl: BASE });
  await expect(digestLink(agent, "https://example.com/otters")).rejects.toThrow(/knows no run/);
});

test("pastDigests asks for this caller's runs by KEY, with the limit it was given", async () => {
  const calls = stubAgent({ runs: [COMPLETED] });
  const agent = await connect({ baseUrl: BASE });

  const runs = await pastDigests(agent, "nightly-job", { limit: 5 });

  expect(runs).toHaveLength(1);
  expect(runs[0]?.status).toBe("completed");
  const listed = calls.find((call) => call.url.includes("/runs?"));
  const query = new URL(listed?.url ?? "").searchParams;
  expect(query.get("workflow")).toBe("digest");
  expect(query.get("key")).toBe("nightly-job");
  expect(query.get("limit")).toBe("5");
});
