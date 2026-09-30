// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * `useRouteMutation` against a stubbed `fetch`: the session's client as the
 * default `?client=`, the busy key, the error from the route's own sentence
 * and its clearing, `onSettled` after either outcome, an older write that
 * cannot overwrite a newer one's outcome, and nothing after unmount.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import { createMockSessionCore } from "./_react-test-utils.ts";
import { SessionProvider } from "./context.ts";
import { type UseRouteMutationOptions, useRouteMutation } from "./use-route-mutation.ts";

let fetchMock: Mock<(url: URL, init: RequestInit) => Promise<Response>>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  fetchMock = vi.fn(async () => json({ saved: true }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", {
    origin: "https://h",
    pathname: "/kitchen/",
    href: "https://h/kitchen/",
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A `fetch` answer the test releases by hand. */
function deferred() {
  let release: (r: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function mount(options: UseRouteMutationOptions = {}) {
  const core = createMockSessionCore({}, { clientId: () => "speaker-7" });
  return renderHook(() => useRouteMutation(options), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children),
  });
}

describe("useRouteMutation", () => {
  test("sends the write for the session's client, names it busy, and re-reads after", async () => {
    const onSettled = vi.fn();
    const slow = deferred();
    fetchMock.mockImplementationOnce(() => slow.promise);
    const hook = mount({ onSettled });
    let answer: Promise<{ saved: boolean } | undefined> = Promise.resolve(undefined);
    act(() => {
      answer = hook.result.current.run("PUT", "/profile", { name: "Ada" }, { key: "name" });
    });
    expect(hook.result.current.busy).toBe("name");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://h/kitchen/api/profile?client=speaker-7");
    expect(init).toMatchObject({ method: "PUT", body: JSON.stringify({ name: "Ada" }) });
    await act(async () => {
      slow.release(json({ saved: true }));
      await answer;
    });
    await expect(answer).resolves.toEqual({ saved: true });
    expect(hook.result.current.busy).toBeUndefined();
    expect(hook.result.current.error).toBeUndefined();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  test("a failure is the route's sentence, resolves undefined, and still re-reads; success or clearError clears it", async () => {
    const onSettled = vi.fn();
    fetchMock.mockResolvedValueOnce(json({ error: "That isn't an email address." }, 400));
    const hook = mount({ onSettled, client: "bedroom" });
    let answer: unknown = "unset";
    await act(async () => {
      answer = await hook.result.current.run("PUT", "/profile", { email: "x" });
    });
    expect(answer).toBeUndefined();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("?client=bedroom");
    expect(hook.result.current.error).toBe("That isn't an email address.");
    expect(onSettled).toHaveBeenCalledTimes(1);
    act(() => hook.result.current.clearError());
    expect(hook.result.current.error).toBeUndefined();

    fetchMock.mockResolvedValueOnce(json({ error: "nope" }, 500));
    await act(async () => {
      await hook.result.current.run("DELETE", "/memories/1");
    });
    expect(hook.result.current.error).toBe("nope");
    await act(async () => {
      await hook.result.current.run("DELETE", "/memories/2");
    });
    expect(hook.result.current.error).toBeUndefined();
  });

  test("busy names the newest write in flight, keyed by method and path by default", async () => {
    const first = deferred();
    const second = deferred();
    fetchMock
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const hook = mount();
    act(() => {
      void hook.result.current.run("DELETE", "/apps/gmail", undefined, { key: "gmail" });
      void hook.result.current.run("DELETE", "/apps/slack");
    });
    expect(hook.result.current.busy).toBe("DELETE /apps/slack");
    await act(async () => {
      second.release(json({}));
    });
    await waitFor(() => expect(hook.result.current.busy).toBe("gmail"));
    await act(async () => {
      first.release(json({}));
    });
    await waitFor(() => expect(hook.result.current.busy).toBeUndefined());
  });

  test("an older write settling late cannot overwrite a newer write's outcome", async () => {
    const older = deferred();
    fetchMock.mockImplementationOnce(() => older.promise).mockResolvedValueOnce(json({ ok: true }));
    const hook = mount();
    let late: Promise<unknown> = Promise.resolve();
    await act(async () => {
      late = hook.result.current.run("PUT", "/profile", { name: "a" });
      await hook.result.current.run("PUT", "/profile", { name: "b" });
    });
    expect(hook.result.current.error).toBeUndefined();
    await act(async () => {
      older.release(json({ error: "stale failure" }, 500));
      await late;
    });
    expect(hook.result.current.error).toBeUndefined();
  });

  test("a write settling after unmount calls nothing", async () => {
    const onSettled = vi.fn();
    const slow = deferred();
    fetchMock.mockImplementationOnce(() => slow.promise);
    const hook = mount({ onSettled });
    let answer: Promise<unknown> = Promise.resolve();
    act(() => {
      answer = hook.result.current.run("POST", "/memories", { text: "x" });
    });
    hook.unmount();
    slow.release(json({ added: true }));
    await expect(answer).resolves.toEqual({ added: true });
    expect(onSettled).not.toHaveBeenCalled();
  });
});
