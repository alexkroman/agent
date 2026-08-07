// Copyright 2026 the AAI authors. MIT license.
/**
 * The recovery only ever runs in a tab whose build was deleted out from
 * under it, so every case here is about the two ways that goes wrong:
 * failing to reload (a dead studio) and reloading too eagerly (a loop that
 * never renders the real error).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installStaleBuildRecovery, lazyRetry, reloadForStaleBuild } from "./stale-build.ts";

/** A `sessionStorage` stand-in — these tests run in the node environment. */
function fakeStorage(overrides: Partial<Storage> = {}): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    ...overrides,
  } as Storage;
}

let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  reload = vi.fn();
  vi.stubGlobal("sessionStorage", fakeStorage());
  vi.stubGlobal("location", { reload });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reloadForStaleBuild", () => {
  it("reloads to pick up the current build", () => {
    expect(reloadForStaleBuild()).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  // The whole reason the marker exists: a chunk that fails for a reason a
  // reload cannot fix (offline, a broken deploy) would otherwise reload
  // forever and never render long enough to show what went wrong.
  it("declines a second reload inside the cooldown", () => {
    expect(reloadForStaleBuild(1000)).toBe(true);
    expect(reloadForStaleBuild(2000)).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });

  // A tab left open across two deploys is the normal case, not an edge one.
  it("recovers again once the cooldown has passed", () => {
    expect(reloadForStaleBuild(1000)).toBe(true);
    expect(reloadForStaleBuild(1000 + 60_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  // A backwards clock step would otherwise leave a marker "in the future"
  // that suppresses every later recovery for the life of the tab.
  it("ignores a marker written in the future", () => {
    expect(reloadForStaleBuild(10_000)).toBe(true);
    expect(reloadForStaleBuild(5000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  // No marker means no loop guard, so declining is the safe direction —
  // reloading unguarded is the failure the guard exists to prevent.
  it("declines rather than reload unguarded when the marker cannot be written", () => {
    vi.stubGlobal(
      "sessionStorage",
      fakeStorage({
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      }),
    );

    expect(reloadForStaleBuild()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  // Same reasoning with no store at all: an unguarded reload loop in a tab
  // that cannot even record that it looped is the worse of the two failures.
  it("declines when storage is unavailable entirely", () => {
    vi.stubGlobal("sessionStorage", undefined);

    expect(reloadForStaleBuild()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("lazyRetry", () => {
  it("passes a successful import straight through", async () => {
    const factory = vi.fn(() => Promise.resolve("module"));

    await expect(lazyRetry(factory)()).resolves.toBe("module");
    expect(factory).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });

  // A dropped connection mid-navigation is not a deploy. Reloading the whole
  // app for it is a heavier answer than asking again.
  it("retries once before deciding the build is gone", async () => {
    const factory = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce("module");

    await expect(lazyRetry(factory)()).resolves.toBe("module");
    expect(factory).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads when both attempts fail", async () => {
    const factory = vi.fn(() => Promise.reject(new Error("404")));
    let settled = false;

    void lazyRetry(factory)().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    await Promise.resolve();

    // The page is navigating away: settling would flash an error boundary
    // over a document about to be replaced.
    expect(settled).toBe(false);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  // Once recovery is exhausted the failure has to reach React, or the Code
  // tab hangs on its Suspense fallback with nothing ever explaining why.
  it("rethrows the failure when a reload is not available", async () => {
    const retryFailure = new Error("chunk 404");
    const factory = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("chunk 404"))
      .mockRejectedValueOnce(retryFailure);
    reloadForStaleBuild(); // burn the cooldown

    await expect(lazyRetry(factory)()).rejects.toBe(retryFailure);
  });
});

describe("installStaleBuildRecovery", () => {
  /** A minimal EventTarget — the tests run outside a DOM. */
  function target() {
    return new EventTarget();
  }

  it("reloads on Vite's preload error", () => {
    const bus = target();
    installStaleBuildRecovery(bus);

    bus.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));

    expect(reload).toHaveBeenCalledOnce();
  });

  // Unprevented, Vite rethrows the error it just reported — so claiming it is
  // the difference between a recovering tab and an uncaught console error.
  it("claims the event so Vite does not rethrow it", () => {
    const bus = target();
    installStaleBuildRecovery(bus);
    const event = new Event("vite:preloadError", { cancelable: true });

    bus.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("unregisters on teardown", () => {
    const bus = target();
    installStaleBuildRecovery(bus)();

    bus.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));

    expect(reload).not.toHaveBeenCalled();
  });
});
