// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * `useClientRuns` against a stubbed `fetch`: the rows off the list route, the
 * cancel URL with its id encoded, the re-read after a cancel, and a failed
 * cancel reported through `error` rather than a rejection.
 */

import type { ClientRun } from "@alexkroman1/aai";
import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import { createMockSessionCore, renderHookWithSession } from "./_react-test-utils.ts";
import { useClientRuns } from "./use-client-runs.ts";

let fetchMock: Mock<(url: URL, init: RequestInit) => Promise<Response>>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ROW: ClientRun = {
  runId: "wrun/1",
  workflow: "remind",
  status: "running",
  title: "Pasta timer",
  createdAt: 1,
};

beforeEach(() => {
  fetchMock = vi.fn(async (_url: URL, init: RequestInit) =>
    init.method === "DELETE" ? json({ cancelled: true }) : json({ runs: [ROW] }),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", {
    origin: "https://h",
    pathname: "/kitchen/",
    href: "https://h/kitchen/",
  });
});

function mount(path?: string) {
  const core = createMockSessionCore({}, { clientId: () => "speaker-7" });
  return renderHookWithSession(() => useClientRuns(path, { pollMs: 0 }), core);
}

const calls = () => fetchMock.mock.calls.map(([url, init]) => `${init.method} ${String(url)}`);

describe("useClientRuns", () => {
  test("reads the rows, cancels by encoded id, and re-reads after", async () => {
    const hook = mount();
    await waitFor(() => expect(hook.result.current.runs).toEqual([ROW]));
    let cancelled: boolean | undefined;
    await act(async () => {
      cancelled = await hook.result.current.cancel("wrun/1");
    });
    expect(cancelled).toBe(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(calls()).toEqual([
      "GET https://h/kitchen/api/tasks?client=speaker-7",
      "DELETE https://h/kitchen/api/tasks/wrun%2F1?client=speaker-7",
      "GET https://h/kitchen/api/tasks?client=speaker-7",
    ]);
    expect(hook.result.current.cancelling).toBeUndefined();
  });

  test("a refused cancel resolves false and is the error; the rows stay", async () => {
    const hook = mount("/running");
    await waitFor(() => expect(hook.result.current.runs).toEqual([ROW]));
    fetchMock.mockResolvedValueOnce(json({ error: "No such run for this client" }, 404));
    let cancelled: boolean | undefined;
    await act(async () => {
      cancelled = await hook.result.current.cancel("wrun/2");
    });
    expect(cancelled).toBe(false);
    expect(hook.result.current.error).toBe("No such run for this client");
    expect(hook.result.current.runs).toEqual([ROW]);
    expect(calls()[1]).toBe("DELETE https://h/kitchen/api/running/wrun%2F2?client=speaker-7");
  });
});
