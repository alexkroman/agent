// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * Specs for the browser workflow client and `useWorkflowRun`.
 *
 * `fetch` is stubbed rather than a server started: what these assert is the
 * REQUEST this client builds (its method, its path, its query, its bearer) and
 * what it makes of the answer — the two halves a page depends on and the two
 * that can silently disagree with `host/workflow-api.ts`.
 *
 * The hook's specs run on virtual time, because every one of them observes a
 * timer: whether a poll re-arms, whether it stops on a terminal status, and
 * whether a stale id is abandoned rather than polled for the life of the tab.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createWorkflowApi,
  DEFAULT_WORKFLOW_POLL_MS,
  MAX_MISSING_READS,
  useWorkflowRun,
  type WorkflowApi,
  type WorkflowRun,
} from "./workflow-client.ts";

const BASE = "https://agents.example/my-agent/";

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: "wrun_1",
    workflow: "digest",
    createdAt: 0,
    status: "running",
    ...over,
  } as WorkflowRun;
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
  const args = fetchMock.mock.calls[n] as [string, RequestInit | undefined];
  return args;
}

describe("createWorkflowApi", () => {
  test("builds every path under the agent's own base URL", async () => {
    fetchMock.mockImplementation(async () => json({ workflows: [{ name: "digest" }] }));
    await createWorkflowApi({ baseUrl: BASE }).list();
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows");
  });

  test("a base URL with no trailing slash resolves the same way", async () => {
    // One resolver (`buildAgentUrl`) rather than a second trailing-slash rule —
    // two of those is how the session's endpoints and this one drift.
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await createWorkflowApi({ baseUrl: "https://agents.example/my-agent" }).list();
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows");
  });

  test("a token rides every request as a bearer", async () => {
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await createWorkflowApi({ baseUrl: BASE, token: "s3cret" }).list();
    expect(call()[1]?.headers).toMatchObject({ Authorization: "Bearer s3cret" });
  });

  test("start posts the workflow, the input and the key, and resolves the run id", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_9" }, 202));
    const id = await createWorkflowApi({ baseUrl: BASE }).start(
      "digest",
      { topic: "ai" },
      { key: "caller-1" },
    );
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

  test("start omits `input` and `key` entirely when they were not given", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_9" }, 202));
    await createWorkflowApi({ baseUrl: BASE }).start("digest");
    expect(JSON.parse(String(call()[1]?.body))).toEqual({ workflow: "digest" });
  });

  test("a failure carries the SERVER'S sentence, not the status", async () => {
    // That text is the whole diagnostic: an unknown workflow names the declared
    // ones, a bad input names the schema issues.
    fetchMock.mockImplementation(async () =>
      json({ error: 'Workflow "nope" is not declared' }, 400),
    );
    await expect(createWorkflowApi({ baseUrl: BASE }).start("nope")).rejects.toThrow(
      'Workflow "nope" is not declared',
    );
  });

  test("a failure that is not our JSON shape degrades to the status", async () => {
    // What a proxy or gateway in front of the agent produces.
    fetchMock.mockImplementation(async () => new Response("<html>502</html>", { status: 502 }));
    await expect(createWorkflowApi({ baseUrl: BASE }).list()).rejects.toThrow("Workflow API 502");
  });

  test("get resolves UNDEFINED for a 404 — an answer, not a failure", async () => {
    fetchMock.mockImplementation(async () => json({ error: "No workflow run with id gone" }, 404));
    await expect(createWorkflowApi({ baseUrl: BASE }).get("gone")).resolves.toBeUndefined();
  });

  test("find sends the key; recent sends none", async () => {
    fetchMock.mockImplementation(async () => json({ runs: [] }));
    const api = createWorkflowApi({ baseUrl: BASE });
    await api.find("digest", "caller-1", { limit: 3 });
    await api.recent("digest");
    expect(call(0)[0]).toContain("workflow=digest&key=caller-1&limit=3");
    expect(call(1)[0]).toContain("workflow=digest");
    expect(call(1)[0]).not.toContain("key=");
  });

  test("a body answering without `runs` reads as an empty list", async () => {
    fetchMock.mockImplementation(async () => json({}));
    await expect(createWorkflowApi({ baseUrl: BASE }).recent("digest")).resolves.toEqual([]);
  });

  test("cancel is a DELETE and reports whether THIS call ended the run", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_1", cancelled: false }));
    const cancelled = await createWorkflowApi({ baseUrl: BASE }).cancel("wrun_1");
    expect(cancelled).toBe(false);
    expect(call()[1]?.method).toBe("DELETE");
  });

  test("a run id is percent-encoded into every path", async () => {
    fetchMock.mockImplementation(async () => json(run()));
    await createWorkflowApi({ baseUrl: BASE }).get("a/b");
    expect(call()[0]).toBe("https://agents.example/my-agent/workflows/runs/a%2Fb");
  });

  test("watch asks for an event stream and returns the raw response", async () => {
    // Raw, because what a caller decides first is whether the agent serves this
    // at all — an older deploy answers 404 and it falls back to polling.
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
    const res = await createWorkflowApi({ baseUrl: BASE }).watch("wrun_1");
    expect(res.status).toBe(404);
    expect(call()[0]).toContain("/workflows/runs/wrun_1/events");
    expect(call()[1]?.headers).toMatchObject({ Accept: "text/event-stream" });
  });
});

describe("useWorkflowRun", () => {
  /**
   * A client whose `watch` always declines, so the hook falls back to the poll.
   * The stream half is specced in `workflow-events.test.ts`.
   */
  function pollingApi(get: WorkflowApi["get"]): WorkflowApi {
    return {
      list: vi.fn(async () => []),
      start: vi.fn(async () => "wrun_1"),
      get,
      find: vi.fn(async () => []),
      recent: vi.fn(async () => []),
      cancel: vi.fn(async () => false),
      watch: vi.fn(async () => new Response(null, { status: 404 })),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("an undefined runId reads as not-polling and costs nothing", () => {
    const api = pollingApi(vi.fn(async () => undefined));
    const { result } = renderHook(() => useWorkflowRun(undefined, { api }));
    expect(result.current).toEqual({ run: undefined, error: undefined, polling: false });
    expect(api.get).not.toHaveBeenCalled();
  });

  test("reports the run and STOPS once it is terminal", async () => {
    const get = vi
      .fn<WorkflowApi["get"]>()
      .mockResolvedValueOnce(run())
      .mockResolvedValue(run({ status: "completed", output: { ok: true } }));
    const { result } = renderHook(() =>
      useWorkflowRun<{ ok: boolean }>("wrun_1", { api: pollingApi(get) }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.run?.status).toBe("running");
    expect(result.current.polling).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKFLOW_POLL_MS);
    });
    expect(result.current.run?.status).toBe("completed");
    expect(result.current.polling).toBe(false);

    // A finished run costs nothing for as long as the page stays open.
    const settled = get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKFLOW_POLL_MS * 5);
    });
    expect(get).toHaveBeenCalledTimes(settled);
  });

  test("gives up on an id the agent keeps reporting as unknown", async () => {
    // A 404 is a STABLE answer, so the budget absorbs a first read racing the
    // run's creation and nothing more — unbounded, a stale id polls (and, on the
    // platform, BROKERS) for as long as the tab is open.
    const get = vi.fn<WorkflowApi["get"]>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useWorkflowRun("stale", { api: pollingApi(get) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKFLOW_POLL_MS * MAX_MISSING_READS);
    });
    expect(get).toHaveBeenCalledTimes(MAX_MISSING_READS);
    expect(result.current.error).toBe("No workflow run stale");
    // `run` stays undefined, which reads as "still waiting" — so `polling` has
    // to come from the stop, not from the snapshot.
    expect(result.current.polling).toBe(false);
  });

  test("a failed read is reported and RETRIED, not fatal", async () => {
    // A dropped request against a booting sandbox is the common case; giving up
    // would strand a live run.
    const get = vi
      .fn<WorkflowApi["get"]>()
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValue(run({ status: "completed", output: 1 }));
    const { result } = renderHook(() => useWorkflowRun("wrun_1", { api: pollingApi(get) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.error).toBe("Failed to fetch");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKFLOW_POLL_MS);
    });
    // Cleared by the next successful read.
    expect(result.current.error).toBeUndefined();
    expect(result.current.run?.status).toBe("completed");
  });

  test("a new id does not show the previous run's state for a frame", async () => {
    const get = vi
      .fn<WorkflowApi["get"]>()
      .mockResolvedValueOnce(run({ status: "completed", output: 1 }));
    const api = pollingApi(get);
    const { result, rerender } = renderHook(({ id }) => useWorkflowRun(id, { api }), {
      initialProps: { id: "wrun_1" as string | undefined },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.run?.status).toBe("completed");
    get.mockImplementation(async () => undefined);
    rerender({ id: "wrun_2" });
    expect(result.current.run).toBeUndefined();
  });

  test("a fresh client object per render does NOT restart the watch", async () => {
    // The natural spelling passes a new object every render; as an effect
    // dependency that is an unbounded request loop against the agent, with
    // `error` wiped before anything can read it.
    const get = vi.fn<WorkflowApi["get"]>().mockResolvedValue(run());
    const { rerender } = renderHook(() => useWorkflowRun("wrun_1", { api: pollingApi(get) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const after = get.mock.calls.length;
    rerender();
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(get).toHaveBeenCalledTimes(after);
  });

  test("unmounting stops the poll", async () => {
    const get = vi.fn<WorkflowApi["get"]>().mockResolvedValue(run());
    const { unmount } = renderHook(() => useWorkflowRun("wrun_1", { api: pollingApi(get) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();
    const after = get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKFLOW_POLL_MS * 5);
    });
    expect(get).toHaveBeenCalledTimes(after);
  });

  test("the client is resolved PER READ, so a token arriving later is picked up", async () => {
    const first = vi.fn<WorkflowApi["get"]>().mockResolvedValue(run());
    const second = vi.fn<WorkflowApi["get"]>().mockResolvedValue(run({ status: "cancelled" }));
    const { rerender } = renderHook(
      ({ get }) => useWorkflowRun("wrun_1", { api: pollingApi(get) }),
      {
        initialProps: { get: first },
      },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    rerender({ get: second });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_WORKFLOW_POLL_MS);
    });
    expect(second).toHaveBeenCalled();
  });

  test("with no client it builds one lazily against the page's own origin", async () => {
    // The `/events` stream declines, so this also covers the fallback to the
    // poll end to end — through the real client rather than a double.
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/events")
        ? new Response(null, { status: 404 })
        : json(run({ status: "completed", output: 1 })),
    );
    const { result } = renderHook(() => useWorkflowRun("wrun_1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.run?.status).toBe("completed");
    expect(String(call(0)[0])).toContain("/workflows/runs/wrun_1");
  });
});
