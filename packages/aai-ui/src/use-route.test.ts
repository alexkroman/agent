// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * `useRoute` against a stubbed `fetch`: the session's client as the default
 * `?client=`, an error that keeps the last data, the stale-read drop and the
 * poll.
 */

import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import { createMockSessionCore, renderHookWithSession } from "./_react-test-utils.ts";
import { useRoute } from "./use-route.ts";

let fetchMock: Mock<(url: URL, init: RequestInit) => Promise<Response>>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  fetchMock = vi.fn(async () => json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", {
    origin: "https://h",
    pathname: "/kitchen/",
    href: "https://h/kitchen/",
  });
});

const lastUrl = () => String(fetchMock.mock.calls.at(-1)?.[0]);

describe("useRoute", () => {
  function mount(path: string | null, pollMs?: number) {
    const core = createMockSessionCore({}, { clientId: () => "speaker-7" });
    return renderHookWithSession(
      () => useRoute<{ ok: boolean }>(path, pollMs ? { pollMs } : {}),
      core,
    );
  }

  test("reads on mount with the session's client, and reports an error without dropping data", async () => {
    const hook = mount("/profile");
    await waitFor(() => expect(hook.result.current.data).toEqual({ ok: true }));
    expect(lastUrl()).toBe("https://h/kitchen/api/profile?client=speaker-7");
    fetchMock.mockResolvedValueOnce(json({ error: "profile store down" }, 500));
    act(() => hook.result.current.reload());
    await waitFor(() => expect(hook.result.current.error).toBe("profile store down"));
    expect(hook.result.current.data).toEqual({ ok: true });
  });

  test("a slow earlier read cannot overwrite a newer one", async () => {
    let releaseSlow: (r: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseSlow = resolve;
        }),
    );
    fetchMock.mockResolvedValueOnce(json({ ok: "newer" }));
    const hook = mount("/profile");
    act(() => hook.result.current.reload());
    await waitFor(() => expect(hook.result.current.data).toEqual({ ok: "newer" }));
    await act(async () => {
      releaseSlow(json({ ok: "stale" }));
    });
    expect(hook.result.current.data).toEqual({ ok: "newer" });
  });

  test("polls while mounted, and a null path reads nothing", async () => {
    vi.useFakeTimers();
    try {
      const hook = mount("/tasks", 1000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      hook.unmount();
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      mount(null);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
