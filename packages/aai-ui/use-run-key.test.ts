// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * Specs for the key six templates used to mint each for themselves.
 *
 * The five properties they had each written by hand are the five asserted here:
 * one key per load, written back for the next one, inside the route's bound,
 * opaque, and degrading — rather than throwing — where storage refuses or is not
 * there at all. That last case is the one a browser suite would never think to
 * cover and the one a Node render hits every time.
 *
 * `renderHook` rather than calling the minting function: the "once per load"
 * property is `useState`'s lazy initializer, so a spec that called a plain
 * function would pass while the hook re-minted on every render.
 *
 * **Both stores are FAKES**, not jsdom's. Two reasons, and the second is the
 * one that decided it: the guarded `globalThis.<store>?.…` access IS what is
 * under test, so a version taking a store would test a shape this package does
 * not ship — and this environment supplies `sessionStorage` while leaving
 * `localStorage` undefined, so half these specs would silently be testing the
 * no-storage path.
 */

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useRunKey } from "./use-run-key.ts";

/** The bound `POST /workflows/runs` puts on a correlation key. */
const MAX_KEY_LENGTH = 256;

/** A `randomUUID`, which is what an opaque key looks like. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * This page's slot, computed the way the hook computes it.
 *
 * Spelled out rather than imported, so a change to the naming has to be made
 * twice — the slot is what a stored key is found under, and the whole mechanism
 * is that two consecutive loads agree on it.
 */
function slot(): string {
  return `aai:run-key:${new URL("./", globalThis.location.href).href}`;
}

/** Just enough `Storage` for one kind, backed by a map a spec can read. */
function fakeStorage(kind: "session" | "local", seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  vi.stubGlobal(kind === "local" ? "localStorage" : "sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  return store;
}

/** Storage that THROWS on both halves — Safari private mode, a sandboxed frame. */
function refusingStorage() {
  vi.stubGlobal("sessionStorage", {
    getItem: () => {
      throw new DOMException("denied");
    },
    setItem: () => {
      throw new DOMException("denied");
    },
  });
}

/** No storage of any kind, which is what a Node render sees. */
function noStorage() {
  vi.stubGlobal("sessionStorage", undefined);
  vi.stubGlobal("localStorage", undefined);
}

afterEach(() => {
  // `restoreMocks` covers `vi.spyOn` and `unstubEnvs` covers `vi.stubEnv`;
  // neither covers a stubbed global, so this is the one teardown these specs
  // owe. Without it the first test to stub storage decides every later one.
  vi.unstubAllGlobals();
});

describe("useRunKey", () => {
  test("mints one key and keeps answering with it across re-renders", () => {
    fakeStorage("session");
    const { result, rerender } = renderHook(() => useRunKey());
    const first = result.current;
    expect(first).toMatch(UUID);
    rerender();
    expect(result.current).toBe(first);
  });

  test("answers a LATER load with the key the first one stored", () => {
    // The whole mechanism in one assertion: this is what a reload sees.
    fakeStorage("session");
    const first = renderHook(() => useRunKey());
    const minted = first.result.current;
    first.unmount();
    // A fresh component, the same tab, the same storage.
    expect(renderHook(() => useRunKey()).result.current).toBe(minted);
  });

  test("writes the minted key back, so the NEXT load can find the run", () => {
    const store = fakeStorage("session");
    const { result } = renderHook(() => useRunKey());
    expect(store.get(slot())).toBe(result.current);
  });

  test("fits the key bound the route enforces, with room to spare", () => {
    fakeStorage("session");
    // 256 is the cap `POST /workflows/runs` applies; a `randomUUID` is 36, and
    // the assertion is here so a future key derived from anything longer fails
    // in this suite rather than as a 400 in a browser.
    expect(renderHook(() => useRunKey()).result.current.length).toBeLessThanOrEqual(MAX_KEY_LENGTH);
  });

  test("is scoped to the page, so another agent's key is not adopted", () => {
    // Every deployed agent is served from one origin at `/:slug/`, so a key
    // stored under a different page must not be read here.
    fakeStorage("session", { "aai:run-key:https://elsewhere.example/other/": "not-this-page" });
    expect(renderHook(() => useRunKey()).result.current).not.toBe("not-this-page");
  });

  test("degrades to a per-load key when storage refuses, rather than throwing", () => {
    refusingStorage();
    // Not remembered — which is the old behaviour, one run per load — but the
    // page renders and the run is still recorded under something.
    const first = renderHook(() => useRunKey()).result.current;
    expect(first).toMatch(UUID);
    expect(renderHook(() => useRunKey()).result.current).not.toBe(first);
  });

  test("works with no storage at all, which is what a Node render sees", () => {
    noStorage();
    // The optional chaining is the whole of what has to hold here.
    expect(() => renderHook(() => useRunKey())).not.toThrow();
    expect(renderHook(() => useRunKey()).result.current).toMatch(UUID);
  });

  test("is opaque — two loads with nothing remembered do not agree", () => {
    // Nothing about the submission goes into it, so two loads that cannot share
    // a key cannot collide. A key derived from the input would.
    noStorage();
    const first = renderHook(() => useRunKey()).result.current;
    expect(renderHook(() => useRunKey()).result.current).not.toBe(first);
  });

  describe('storage: "local"', () => {
    test("remembers the key past the tab, for a run that sleeps for days", () => {
      const local = fakeStorage("local");
      const session = fakeStorage("session");
      const { result } = renderHook(() => useRunKey({ storage: "local" }));
      expect(local.get(slot())).toBe(result.current);
      // And nothing was written to the tab-scoped store, which is the point of
      // the option: a schedule stopped on Friday was started in another tab.
      expect(session.get(slot())).toBeUndefined();
    });

    test("reads back what a previous browser session stored", () => {
      fakeStorage("local", { [slot()]: "kept-across-the-browser" });
      expect(renderHook(() => useRunKey({ storage: "local" })).result.current).toBe(
        "kept-across-the-browser",
      );
    });

    test("does not read the session store's key", () => {
      // The two stores are separate handles. A page that switched storage kinds
      // starts a new key rather than adopting one with the wrong lifetime.
      fakeStorage("local");
      fakeStorage("session", { [slot()]: "tab-scoped" });
      expect(renderHook(() => useRunKey({ storage: "local" })).result.current).not.toBe(
        "tab-scoped",
      );
    });
  });
});
