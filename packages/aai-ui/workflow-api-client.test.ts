// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
/**
 * `createWorkflowApi` — REQUEST SHAPING only: what goes on the wire, and which
 * non-2xx answers are failures as opposed to answers (a 404 from `get` is "no such
 * run yet", which a page polling an id it just started hits legitimately).
 *
 * Split from `workflow-client.test.ts` when it reached the 700-line test cap. The
 * seam is request-versus-loop: the hook's behaviour over TIME lives there, and the
 * stream lives in `workflow-events.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { createWorkflowApi } from "./workflow-client.ts";

const BASE = "https://agent.example/app";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Spy on `fetch`, answering with `responses` in order (the last one repeats).
 *
 * A spy rather than `vi.stubGlobal` because `restoreMocks` undoes a spy for free
 * while `unstubGlobals` is not set in the shared config — so a stub would need the
 * hand-rolled teardown the root guide forbids.
 */
function stubFetch(...responses: Response[]) {
  let i = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return Promise.resolve(next ?? json({}));
  });
}

function urlOf(spy: ReturnType<typeof stubFetch>, call = 0): string {
  return String(spy.mock.calls[call]?.[0]);
}

function initOf(spy: ReturnType<typeof stubFetch>, call = 0): RequestInit {
  return (spy.mock.calls[call]?.[1] ?? {}) as RequestInit;
}

function headersOf(spy: ReturnType<typeof stubFetch>, call = 0): Record<string, string> {
  return (initOf(spy, call).headers ?? {}) as Record<string, string>;
}

describe("createWorkflowApi URL + auth", () => {
  it.each([
    ["no trailing slash", BASE],
    ["a trailing slash", `${BASE}/`],
  ])("resolves the same /workflows path from a base with %s", async (_label, baseUrl) => {
    const spy = stubFetch(json({ workflows: [] }));
    await createWorkflowApi({ baseUrl }).list();
    expect(urlOf(spy)).toBe("https://agent.example/app/workflows");
  });

  it("defaults to the page's own origin and path", async () => {
    const spy = stubFetch(json({ workflows: [] }));
    await createWorkflowApi().list();
    expect(urlOf(spy)).toBe(`${location.origin}${location.pathname}workflows`);
  });

  it("sends a bearer on every route when a token is given", async () => {
    const spy = stubFetch(json({ workflows: [] }), json({ runId: "r1" }));
    const api = createWorkflowApi({ baseUrl: BASE, token: "sekret" });
    await api.list();
    await api.start("w");
    expect(headersOf(spy, 0).Authorization).toBe("Bearer sekret");
    expect(headersOf(spy, 1).Authorization).toBe("Bearer sekret");
  });

  it("sends no Authorization header without a token — a public page has none", async () => {
    const spy = stubFetch(json({ workflows: [] }));
    await createWorkflowApi({ baseUrl: BASE }).list();
    expect(headersOf(spy)).not.toHaveProperty("Authorization");
  });
});

describe("createWorkflowApi.list", () => {
  it("returns the declared workflows", async () => {
    const workflows = [{ name: "review", description: "Post-call review" }];
    stubFetch(json({ workflows }));
    await expect(createWorkflowApi({ baseUrl: BASE }).list()).resolves.toEqual(workflows);
  });

  it("degrades a body with no workflows key to an empty list", async () => {
    stubFetch(json({}));
    await expect(createWorkflowApi({ baseUrl: BASE }).list()).resolves.toEqual([]);
  });
});

describe("createWorkflowApi.start", () => {
  it("resolves the run id without waiting for the run", async () => {
    stubFetch(json({ runId: "run-7" }));
    await expect(createWorkflowApi({ baseUrl: BASE }).start("review")).resolves.toBe("run-7");
  });

  it("posts to /runs as JSON", async () => {
    const spy = stubFetch(json({ runId: "r" }));
    await createWorkflowApi({ baseUrl: BASE }).start("review", { blobId: "b1" });
    expect(urlOf(spy)).toBe("https://agent.example/app/workflows/runs");
    expect(initOf(spy).method).toBe("POST");
    expect(headersOf(spy)["Content-Type"]).toBe("application/json");
  });

  it("omits input entirely when none is given", async () => {
    const spy = stubFetch(json({ runId: "r" }));
    await createWorkflowApi({ baseUrl: BASE }).start("review");
    expect(initOf(spy).body).toBe(JSON.stringify({ workflow: "review" }));
  });

  it("carries the input when given", async () => {
    const spy = stubFetch(json({ runId: "r" }));
    await createWorkflowApi({ baseUrl: BASE }).start("review", { ms: 5 });
    expect(initOf(spy).body).toBe(JSON.stringify({ workflow: "review", input: { ms: 5 } }));
  });
});

describe("createWorkflowApi.get", () => {
  it("returns the snapshot", async () => {
    const run = { runId: "r1", status: "completed", output: 42 };
    stubFetch(json(run));
    await expect(createWorkflowApi({ baseUrl: BASE }).get("r1")).resolves.toEqual(run);
  });

  it("answers undefined for a 404 — an unknown id is an ANSWER, not a failure", async () => {
    stubFetch(new Response("", { status: 404 }));
    await expect(createWorkflowApi({ baseUrl: BASE }).get("nope")).resolves.toBeUndefined();
  });

  it("percent-encodes the id into the path", async () => {
    const spy = stubFetch(json({ status: "running" }));
    await createWorkflowApi({ baseUrl: BASE }).get("a/b c");
    expect(urlOf(spy)).toBe("https://agent.example/app/workflows/runs/a%2Fb%20c");
  });
});

describe("createWorkflowApi.upload", () => {
  it("resolves the blob id naming the bytes", async () => {
    stubFetch(json({ blobId: "b-1", bytes: 3 }));
    const api = createWorkflowApi({ baseUrl: BASE });
    await expect(api.upload(new Uint8Array([1, 2, 3]))).resolves.toEqual({
      blobId: "b-1",
      bytes: 3,
    });
  });

  it("sends the payload AS-IS rather than copying it into a Blob", async () => {
    const spy = stubFetch(json({ blobId: "b", bytes: 2 }));
    const bytes = new Uint8Array([7, 8]);
    await createWorkflowApi({ baseUrl: BASE }).upload(bytes, "audio/pcm");
    // Identity, not equality: wrapping copied the whole payload — ~2 MB per
    // chunk in the transcription page.
    expect(initOf(spy).body).toBe(bytes);
    expect(headersOf(spy)["Content-Type"]).toBe("audio/pcm");
  });

  it("defaults the content type to octet-stream", async () => {
    const spy = stubFetch(json({ blobId: "b", bytes: 0 }));
    await createWorkflowApi({ baseUrl: BASE }).upload("hi");
    expect(headersOf(spy)["Content-Type"]).toBe("application/octet-stream");
  });
});

describe("createWorkflowApi failures", () => {
  it("throws the server's own error sentence — it names the fix", async () => {
    stubFetch(json({ error: 'Unknown workflow "revue". Declared: review' }, 400));
    await expect(createWorkflowApi({ baseUrl: BASE }).start("revue")).rejects.toThrow(
      'Unknown workflow "revue". Declared: review',
    );
  });

  it("falls back to the status for a non-JSON body — a proxy in front of the agent", async () => {
    stubFetch(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    await expect(createWorkflowApi({ baseUrl: BASE }).list()).rejects.toThrow(
      "Workflow API 502: <html>502 Bad Gateway</html>",
    );
  });

  it("falls back to the status when JSON carries no error string", async () => {
    stubFetch(json({ detail: "nope" }, 500));
    await expect(createWorkflowApi({ baseUrl: BASE }).list()).rejects.toThrow(
      /^Workflow API 500: /,
    );
  });

  it("truncates a long body to 200 characters", async () => {
    stubFetch(new Response("x".repeat(500), { status: 413 }));
    // Asserted as an exact message rather than `rejects.toThrow`, which matches
    // a SUBSTRING — a body truncated to 300 would satisfy that and not this.
    const message = await createWorkflowApi({ baseUrl: BASE })
      .upload("big")
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(message).toBe(`Workflow API 413: ${"x".repeat(200)}`);
  });

  it("reports the bare status when the body is empty", async () => {
    stubFetch(new Response("", { status: 401 }));
    await expect(createWorkflowApi({ baseUrl: BASE }).list()).rejects.toThrow("Workflow API 401");
  });

  it("a get failure that is not a 404 still throws", async () => {
    stubFetch(json({ error: "boom" }, 500));
    await expect(createWorkflowApi({ baseUrl: BASE }).get("r")).rejects.toThrow("boom");
  });
});

describe("createWorkflowApi.start options", () => {
  it("puts a correlation key on the wire only when one is given", async () => {
    const fetchSpy = stubFetch(json({ runId: "r1" }, 202), json({ runId: "r2" }, 202));
    const api = createWorkflowApi({ baseUrl: BASE });

    await api.start("review", { a: 1 }, { key: "user-9" });
    await api.start("review", { a: 1 });

    const withKey = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    const without = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body));
    expect(withKey).toEqual({ workflow: "review", input: { a: 1 }, key: "user-9" });
    // Absent rather than `null`: the route refuses a non-string key, and a page
    // that passed none is not making a claim about one.
    expect(without).toEqual({ workflow: "review", input: { a: 1 } });
  });
});

describe("createWorkflowApi.find", () => {
  it("sends the workflow, key and limit as query parameters", async () => {
    const fetchSpy = stubFetch(json({ runs: [] }));
    await createWorkflowApi({ baseUrl: BASE }).find("review", "user-9", { limit: 3 });

    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/app/workflows/runs");
    expect(url.searchParams.get("workflow")).toBe("review");
    expect(url.searchParams.get("key")).toBe("user-9");
    expect(url.searchParams.get("limit")).toBe("3");
  });

  it("omits the limit when the caller names none", async () => {
    const fetchSpy = stubFetch(json({ runs: [] }));
    await createWorkflowApi({ baseUrl: BASE }).find("review", "user-9");

    expect(new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams.has("limit")).toBe(false);
  });

  it("returns the runs, and an empty list for a body carrying none", async () => {
    const runs = [{ runId: "r1", workflow: "review", status: "completed", stepsCompleted: 1 }];
    stubFetch(json({ runs }), json({}));
    const api = createWorkflowApi({ baseUrl: BASE });

    await expect(api.find("review", "k")).resolves.toEqual(runs);
    await expect(api.find("review", "k")).resolves.toEqual([]);
  });

  it("throws on a failure, carrying the server's sentence", async () => {
    stubFetch(json({ error: "Declared workflows: digest" }, 400));
    await expect(createWorkflowApi({ baseUrl: BASE }).find("nope", "k")).rejects.toThrow(
      "Declared workflows: digest",
    );
  });
});

describe("createWorkflowApi.cancel", () => {
  it("DELETEs the run and reports whether it stopped it", async () => {
    const fetchSpy = stubFetch(json({ runId: "r1", cancelled: true }));

    await expect(createWorkflowApi({ baseUrl: BASE }).cancel("r1")).resolves.toBe(true);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(`${BASE}/workflows/runs/r1`);
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("reports false for a run that had already finished", async () => {
    // Not an error: the route answers 200 either way, because two tabs pressing
    // Stop is ordinary.
    stubFetch(json({ runId: "r1", cancelled: false }));
    await expect(createWorkflowApi({ baseUrl: BASE }).cancel("r1")).resolves.toBe(false);
  });

  it("encodes the run id", async () => {
    const fetchSpy = stubFetch(json({ cancelled: false }));
    await createWorkflowApi({ baseUrl: BASE }).cancel("a b/c");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("a%20b%2Fc");
  });
});
