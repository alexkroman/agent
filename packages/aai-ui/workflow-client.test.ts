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
  DEFAULT_WORKFLOW_POLL_MS,
  isTerminal,
  MAX_MISSING_READS,
  useWorkflowRun,
  type WorkflowApi,
  type WorkflowRun,
} from "./workflow-client.ts";

const _BASE = "https://agent.example/app";

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
function _urlOf(spy: ReturnType<typeof stubFetch>, call = 0): string {
  return String(spy.mock.calls[call]?.[0]);
}

function initOf(spy: ReturnType<typeof stubFetch>, call = 0): RequestInit {
  return (spy.mock.calls[call]?.[1] ?? {}) as RequestInit;
}

function _headersOf(spy: ReturnType<typeof stubFetch>, call = 0): Record<string, string> {
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
    // The first request is the EVENT STREAM, since the hook prefers a push and
    // falls back to the poll; both go through the client it built, which is what
    // this asserts. The 404 is how an agent with no `/events` route answers, so the
    // fallback is exercised too.
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve(
        url.endsWith("/events")
          ? new Response(null, { status: 404 })
          : json({ runId: "r1", status: "completed" }),
      );
    });
    const { result } = renderHook(() => useWorkflowRun("r1"));
    await waitFor(() => expect(result.current.run?.status).toBe("completed"));

    const urls = spy.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toBe(`${location.origin}${location.pathname}workflows/runs/r1/events`);
    expect(urls).toContain(`${location.origin}${location.pathname}workflows/runs/r1`);
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

/**
 * A `WorkflowApi` whose `get` is scripted, for the polling specs.
 *
 * `watch` answers 404, which is how an agent deployed before the SSE route
 * existed answers — so `useWorkflowRun` hands over to the poll immediately and
 * every spec below exercises the FALLBACK. The stream has its own specs; keeping
 * these on the poll is what makes them still about polling.
 */
function fakeApi(get: WorkflowApi["get"], watch?: WorkflowApi["watch"]): WorkflowApi {
  return {
    get,
    watch: watch ?? (() => Promise.resolve(new Response(null, { status: 404 }))),
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
