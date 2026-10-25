// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for what a reload remembers — `recover.ts`.
 *
 * This is the testable half of the page's recovery: handing back a mode that
 * may not be a mode any more. The KEY and the sentence under the form are the
 * SDK's (`useWorkflowSubmit`, `<WorkflowPendingNote>`), specced there — this
 * package's suites have no DOM (the vitest `include` matches `.test.ts` and not
 * `.test.tsx`), so nothing a hook does on mount can be asserted here.
 *
 * Storage is a FAKE rather than jsdom's, for the same reason: `sessionStorage`
 * does not exist in Node, which is also the environment in which every guard in
 * `recover.ts` matters — a page that cannot reach storage still has to render.
 */

import { describe, expect, test, vi } from "vitest";
import { recalledMode, rememberMode } from "./recover.ts";

/** The modes the page offers, in the page's own order. */
const MODES = ["streaming", "classic", "batch"] as const;

/**
 * Just enough `Storage` for the two recall functions, backed by a map a spec
 * can read.
 *
 * `vi.stubGlobal` rather than an injected parameter, because the guarded
 * `globalThis.sessionStorage?.…` access IS the thing under test — a version
 * taking a store would test a shape the template does not ship.
 */
function fakeStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  vi.stubGlobal("sessionStorage", {
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

// No teardown: `unstubGlobals` (set by `defineAgentTestConfig`) undoes every
// stubbed storage after its test, so the first file to stub it cannot decide
// every later one.

describe("recalledMode", () => {
  test("opens on the mode the last submission used", () => {
    fakeStorage({ "transcription-workflow:mode": "batch" });
    expect(recalledMode(MODES, "streaming")).toBe("batch");
  });

  test("falls back for a stored value that is not a mode any more", () => {
    // The branch this function exists for. The page turns a mode into a
    // workflow NAME, so an unchecked value here starts a run called `undefined`
    // and answers a 400 nobody typed.
    fakeStorage({ "transcription-workflow:mode": "webhook" });
    expect(recalledMode(MODES, "streaming")).toBe("streaming");
  });

  test("falls back when nothing has been stored yet", () => {
    fakeStorage();
    expect(recalledMode(MODES, "streaming")).toBe("streaming");
  });

  test("falls back when storage refuses", () => {
    refusingStorage();
    expect(recalledMode(MODES, "classic")).toBe("classic");
  });

  test("round-trips what rememberMode wrote", () => {
    fakeStorage();
    rememberMode("classic");
    expect(recalledMode(MODES, "streaming")).toBe("classic");
  });

  test("rememberMode is silent when storage refuses", () => {
    refusingStorage();
    expect(() => rememberMode("classic")).not.toThrow();
  });
});
