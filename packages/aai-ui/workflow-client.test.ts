// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the static page's workflow client.
 *
 * Two halves with different hazards. `createWorkflowApi` is request shaping —
 * what goes on the wire, and which non-2xx answers are FAILURES as opposed to
 * answers (a 404 from `get` is "no such run yet", which a page polling an id it
 * just started hits legitimately). `useWorkflowRun` is a loop, so its specs are
 * about what it does over TIME: it stops on a terminal status, it re-arms from
 * the settled read rather than on an interval, and it survives a failed read.
 *
 * The loop runs on virtual time throughout — see "A spec that observes a TIMER
 * runs on virtual time" in the root guide. Nothing here waits out a real
 * millisecond.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkflowApi,
  DEFAULT_WORKFLOW_POLL_MS,
  isTerminal,
  MAX_MISSING_READS,
  useWorkflowRun,
  type WorkflowApi,
  type WorkflowRun,
} from "./workflow-client.ts";

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
 * A spy rather than `vi.stubGlobal` because `restoreMocks` undoes a spy for
 * free while `unstubGlobals` is not set in the shared config — so a stub would
 * need the hand-rolled teardown the root guide forbids.
 */
function stubFetch(...responses: Response[]) {
  let i = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return Promise.resolve(next ?? json({}));
  });
}

/** The URL a recorded `fetch` call was made against. */
function urlOf(spy: ReturnType<typeof stubFetch>, call = 0): string {
  return String(spy.mock.calls[call]?.[0]);
}

function initOf(spy: ReturnType<typeof stubFetch>, call = 0): RequestInit {
  return (spy.mock.calls[call]?.[1] ?? {}) as RequestInit;
}

function headersOf(spy: ReturnType<typeof stubFetch>, call = 0): Record<string, string> {
  return (initOf(spy, call).headers ?? {}) as Record<string, string>;
}

describe("isTerminal", () => {
  it.each([
    ["completed", true],
    ["failed", true],
    ["running", false],
    ["pending", false],
  ] as const)("%s -> %s", (status, expected) => {
    expect(isTerminal({ status } as WorkflowRun)).toBe(expected);
  });

  it("an absent run is not terminal — nothing has been read yet", () => {
    expect(isTerminal(undefined)).toBe(false);
  });
});

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

/** A `WorkflowApi` whose `get` is scripted, for the polling specs. */
function fakeApi(get: WorkflowApi["get"]): WorkflowApi {
  return {
    get,
    list: () => Promise.reject(new Error("unused")),
    start: () => Promise.reject(new Error("unused")),
    find: () => Promise.reject(new Error("unused")),
    recent: () => Promise.reject(new Error("unused")),
    cancel: () => Promise.reject(new Error("unused")),
    retry: () => Promise.reject(new Error("unused")),
    upload: () => Promise.reject(new Error("unused")),
  };
}

/** Scripted snapshots, one per `get` call; the last repeats. */
function scriptedApi(...statuses: WorkflowRun["status"][]) {
  const get = vi.fn((runId: string) => {
    const at = Math.min(get.mock.calls.length - 1, statuses.length - 1);
    return Promise.resolve({ runId, status: statuses[at] } as WorkflowRun);
  });
  return { api: fakeApi(get), get };
}

describe("useWorkflowRun", () => {
  it("reads the run once immediately", async () => {
    vi.useFakeTimers();
    try {
      const { api, get } = scriptedApi("completed");
      const { result } = renderHook(() => useWorkflowRun("r1", { api }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(get).toHaveBeenCalledTimes(1);
      expect(result.current.run?.status).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls a live run and STOPS once it is terminal", async () => {
    vi.useFakeTimers();
    try {
      const { api, get } = scriptedApi("running", "running", "completed");
      renderHook(() => useWorkflowRun("r1", { api, intervalMs: 1000 }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(get).toHaveBeenCalledTimes(3);
      // A finished run must cost nothing for as long as the page stays open.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(get).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms from the SETTLED read, so a slow response cannot stack polls", async () => {
    vi.useFakeTimers();
    try {
      const gate = Promise.withResolvers<WorkflowRun | undefined>();
      const get = vi.fn(() => gate.promise);
      const api = fakeApi(get);
      renderHook(() => useWorkflowRun("r1", { api, intervalMs: 100 }));
      // Ten intervals elapse while the first read is still in flight.
      await vi.advanceTimersByTimeAsync(1000);
      expect(get).toHaveBeenCalledTimes(1);
      // Settling it arms the NEXT read, which is the other half of the rule:
      // one read in flight, and the timer starts when that read lands.
      // Resolved as an unknown id so nothing re-renders — this spec is about
      // the loop, and a state update here would need an `act` the rejection
      // note below explains away.
      gate.resolve(undefined);
      await vi.advanceTimersByTimeAsync(100);
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries an unknown id briefly — the page can race the journal write", async () => {
    vi.useFakeTimers();
    try {
      const get = vi.fn((): Promise<WorkflowRun | undefined> => Promise.resolve(undefined));
      const api = fakeApi(get);
      const { result } = renderHook(() => useWorkflowRun("r1", { api, intervalMs: 50 }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(get.mock.calls.length).toBeGreaterThan(1);
      expect(result.current.run).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on an id the agent keeps saying it does not have", async () => {
    vi.useFakeTimers();
    try {
      // A 404 is a STABLE answer — the journal is durable — so retrying it
      // unbounded is how a stale id (restored from `localStorage`, or one whose
      // agent was redeployed onto a fresh database) polls forever: `polling`
      // stays true so the page stays busy, and on the platform every read
      // BROKERS, keeping a sandbox resident for a run that does not exist.
      const get = vi.fn((): Promise<WorkflowRun | undefined> => Promise.resolve(undefined));
      const api = fakeApi(get);
      const { result } = renderHook(() => useWorkflowRun("r1", { api, intervalMs: 10 }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(get).toHaveBeenCalledTimes(MAX_MISSING_READS);
      expect(result.current.polling).toBe(false);
      expect(result.current.error).toContain("r1");
    } finally {
      vi.useRealTimers();
    }
  });

  // The two rejection specs below run on REAL timers and settle with `waitFor`,
  // which is the one place this file departs from virtual time. `await act()`
  // never resolves once a read has rejected — measured with real timers too, so
  // it is `act` and a rejected continuation rather than the clock — and these
  // two observe a state transition rather than a timer window, so a tiny
  // interval plus `waitFor` costs no wall-clock time worth naming. Every spec
  // that observes the INTERVAL itself stays on fake timers.
  it("REPORTS a failed read and retries it — giving up would strand a live run", async () => {
    const get = vi
      .fn<WorkflowApi["get"]>()
      .mockRejectedValueOnce(new Error("sandbox booting"))
      .mockResolvedValue({ runId: "r1", status: "completed" } as WorkflowRun);
    // Wide enough that the reported error is observable before the retry
    // clears it — at a 1ms interval the recovery outran the assertion.
    const api = fakeApi(get);
    const { result } = renderHook(() => useWorkflowRun("r1", { api, intervalMs: 150 }));
    await waitFor(() => expect(result.current.error).toBe("sandbox booting"));
    // Cleared by the next successful read, which also lands the run.
    await waitFor(() => expect(result.current.run?.status).toBe("completed"));
    expect(result.current.error).toBeUndefined();
  });

  it("stringifies a non-Error rejection", async () => {
    const get = vi.fn(() => Promise.reject("plain string"));
    const api = fakeApi(get) as WorkflowApi;
    const { result } = renderHook(() => useWorkflowRun("r1", { api, intervalMs: 1 }));
    await waitFor(() => expect(result.current.error).toBe("plain string"));
  });

  it("clears the previous run when the id changes", async () => {
    vi.useFakeTimers();
    try {
      const { api } = scriptedApi("completed");
      const { result, rerender } = renderHook(
        ({ id }: { id: string }) => useWorkflowRun(id, { api }),
        { initialProps: { id: "r1" } },
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.run?.runId).toBe("r1");
      // A new id must not show the previous run's state for one frame — that is
      // what makes "started, still waiting" read as "completed".
      rerender({ id: "r2" });
      expect(result.current.run).toBeUndefined();
      // Flushed so the new id's first read lands inside `act` — and it proves
      // the poll followed the id rather than staying on the old one.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.run?.runId).toBe("r2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls nothing when no run has been started", async () => {
    vi.useFakeTimers();
    try {
      const { api, get } = scriptedApi("running");
      const { result } = renderHook(() => useWorkflowRun(undefined, { api, intervalMs: 10 }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(get).not.toHaveBeenCalled();
      expect(result.current.polling).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the loop on unmount", async () => {
    vi.useFakeTimers();
    try {
      const { api, get } = scriptedApi("running");
      const { unmount } = renderHook(() => useWorkflowRun("r1", { api, intervalMs: 100 }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(get).toHaveBeenCalledTimes(1);
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // The three guards for a read that settles AFTER the loop was stopped. The
  // page is gone by then, so the only observable consequences are the ones
  // asserted here: no re-arm (a leaked loop would poll a closed page forever)
  // and no state write (React warns, and it would resurrect a stale run).
  it("drops a read that resolves after unmount, and does not re-arm", async () => {
    vi.useFakeTimers();
    try {
      const gate = Promise.withResolvers<WorkflowRun | undefined>();
      const get = vi.fn(() => gate.promise);
      const api = fakeApi(get);
      const { unmount } = renderHook(() => useWorkflowRun("r1", { api, intervalMs: 100 }));
      await vi.advanceTimersByTimeAsync(0);
      unmount();
      // A non-terminal run: were the guard missing, this would re-arm the timer.
      gate.resolve({ runId: "r1", status: "running" } as WorkflowRun);
      await vi.advanceTimersByTimeAsync(1000);
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a rejection that settles after unmount", async () => {
    vi.useFakeTimers();
    try {
      const gate = Promise.withResolvers<WorkflowRun | undefined>();
      const get = vi.fn(() => gate.promise);
      const api = fakeApi(get);
      const { unmount } = renderHook(() => useWorkflowRun("r1", { api, intervalMs: 100 }));
      await vi.advanceTimersByTimeAsync(0);
      unmount();
      gate.reject(new Error("too late"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT restart the poll when the caller rebuilds its client each render", async () => {
    vi.useFakeTimers();
    try {
      const { get } = scriptedApi("running");
      // The natural-but-wrong spelling: a fresh client object per render. As an
      // effect dep this restarted the loop every render, and since the effect
      // opens by clearing state each restart re-rendered — an unbounded request
      // loop. One read per interval is the whole assertion.
      const { rerender } = renderHook(() =>
        useWorkflowRun("r1", { api: fakeApi(get), intervalMs: 1000 }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(get).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 5; i++) rerender();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(get).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("picks up a swapped client on the NEXT read, without restarting", async () => {
    vi.useFakeTimers();
    try {
      const first = scriptedApi("running");
      const second = scriptedApi("running");
      const { rerender } = renderHook(
        ({ api }: { api: WorkflowApi }) => useWorkflowRun("r1", { api, intervalMs: 1000 }),
        { initialProps: { api: first.api } },
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(first.get).toHaveBeenCalledTimes(1);
      // A token arriving after login is the real case for this.
      rerender({ api: second.api });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(second.get).toHaveBeenCalledTimes(1);
      // The swap costs no extra read — the loop kept its place.
      expect(first.get).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports polling while a run is live and false once it is terminal", async () => {
    vi.useFakeTimers();
    try {
      const { api } = scriptedApi("running", "completed");
      const { result } = renderHook(() => useWorkflowRun("r1", { api, intervalMs: 100 }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.polling).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(result.current.polling).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults the interval to DEFAULT_WORKFLOW_POLL_MS", async () => {
    vi.useFakeTimers();
    try {
      const { api, get } = scriptedApi("running");
      renderHook(() => useWorkflowRun("r1", { api }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEFAULT_WORKFLOW_POLL_MS - 1);
      });
      expect(get).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds its own client when none is passed", async () => {
    vi.useFakeTimers();
    try {
      const spy = stubFetch(json({ runId: "r1", status: "completed" }));
      renderHook(() => useWorkflowRun("r1"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(urlOf(spy)).toBe(`${location.origin}${location.pathname}workflows/runs/r1`);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a cancelled run is finished", () => {
  it("stops polling, because isTerminal comes from the SDK's own status union", async () => {
    vi.useFakeTimers();
    try {
      // A second local copy of `isTerminal` listing only completed/failed would
      // poll a cancelled run for as long as the page stayed open — which is why
      // this one is re-exported from the SDK rather than defined here.
      const { api, get } = scriptedApi("cancelled");
      const { result } = renderHook(() => useWorkflowRun("r1", { api, intervalMs: 1000 }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.run?.status).toBe("cancelled");
      expect(result.current.polling).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
