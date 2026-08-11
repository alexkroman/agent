// Copyright 2026 the AAI authors. MIT license.
/**
 * The remembered-runs list.
 *
 * Mostly failure paths, because that is where the risk is: `localStorage` reads
 * THROW in a blocked-storage browser rather than returning null, and the value
 * is a string anything could have written. Neither may take the page down —
 * losing the bookmark must never look like losing the transcription.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { loadRuns, rememberRun, type SavedRun } from "./runs.ts";

const KEY = "transcription-desk:runs";

/** A `localStorage` good enough to be the real thing for these tests. */
function installStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

const run = (runId: string, label = `${runId}.mp3`): SavedRun => ({
  runId,
  label,
  startedAt: 1000,
});

beforeEach(() => {
  installStorage();
});

describe("loadRuns", () => {
  test("is empty before anything has been started", () => {
    expect(loadRuns()).toEqual([]);
  });

  test("reads back what was remembered", () => {
    rememberRun(run("a"));
    expect(loadRuns()).toEqual([run("a")]);
  });

  test("answers [] when storage THROWS rather than returning null", () => {
    // Safari's private mode, a third-party iframe, a hardened profile: the
    // access itself raises. A transcription app must not fail to load over its
    // own history sidebar.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError: storage is disabled");
      },
      setItem: () => undefined,
    });
    expect(loadRuns()).toEqual([]);
  });

  test("answers [] for a value that is not JSON", () => {
    installStorage({ [KEY]: "not json{" });
    expect(loadRuns()).toEqual([]);
  });

  test("answers [] for JSON that is not a list", () => {
    installStorage({ [KEY]: '{"runId":"a"}' });
    expect(loadRuns()).toEqual([]);
  });

  test("drops entries of the wrong shape and keeps the rest", () => {
    // An older build of this page, or an extension, may have written anything.
    // One bad row must not cost the whole history.
    installStorage({
      [KEY]: JSON.stringify([run("a"), { runId: "b" }, null, "c", run("d")]),
    });
    expect(loadRuns()).toEqual([run("a"), run("d")]);
  });
});

describe("rememberRun", () => {
  test("puts the newest first, so the list reads as history", () => {
    rememberRun(run("a"));
    const after = rememberRun(run("b"));
    expect(after.map((r) => r.runId)).toEqual(["b", "a"]);
    expect(loadRuns().map((r) => r.runId)).toEqual(["b", "a"]);
  });

  test("re-remembering an id moves it rather than duplicating it", () => {
    rememberRun(run("a"));
    rememberRun(run("b"));
    expect(rememberRun(run("a")).map((r) => r.runId)).toEqual(["a", "b"]);
  });

  test("caps the list, because localStorage is a shared origin quota", () => {
    for (let i = 0; i < 25; i++) rememberRun(run(`r${i}`));
    const stored = loadRuns();
    expect(stored).toHaveLength(20);
    // The cap drops the OLDEST, so the most recent run is always present.
    expect(stored[0]?.runId).toBe("r24");
  });

  test("re-reads storage first, so a second tab's runs are not clobbered", () => {
    // Both tabs hold their own React state; the one that writes last must merge
    // rather than replace, or opening a second tab silently erases the history.
    const store = installStorage();
    rememberRun(run("from-tab-one"));
    store.set(KEY, JSON.stringify([run("from-tab-two"), ...loadRuns()]));
    expect(rememberRun(run("from-tab-one-again")).map((r) => r.runId)).toEqual([
      "from-tab-one-again",
      "from-tab-two",
      "from-tab-one",
    ]);
  });

  test("still returns the new list when the WRITE fails", () => {
    // Quota exceeded, or storage blocked. The run has already started and is
    // safe on the server — losing the bookmark must not surface as a failure.
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(() => rememberRun(run("a"))).not.toThrow();
    expect(rememberRun(run("a"))).toEqual([run("a")]);
  });
});
