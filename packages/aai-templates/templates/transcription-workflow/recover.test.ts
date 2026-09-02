// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for what a reload remembers — `recover.ts`.
 *
 * This is the testable half of the page's recovery, and the split is worth
 * knowing before adding to either side. What lives HERE is the decisions that
 * are ordinary functions: handing back a mode that may not be a mode any more,
 * and which sentence a reader gets. The KEY is not one of them any more — it is
 * `useRunKey()` (`@alexkroman1/aai-ui`), specced there, over the hook that mints
 * it. What CANNOT live here is the other hook — `useWorkflowSubmit({ key,
 * recover: true })` adopting the key's newest run, once per mount, and never
 * over a run the person has already started — because this package's suites
 * have no DOM (the vitest `include`
 * matches `.test.ts` and not `.test.tsx`, and the scaffold declares no React
 * testing library, so a `client.test.tsx` would be collected by nothing here
 * and would break `aai test` in a scaffolded project). That half is specced in
 * `@alexkroman1/aai-ui`, over the hook itself.
 *
 * Storage is a FAKE rather than jsdom's, for the same reason: `sessionStorage`
 * does not exist in Node, which is also the environment in which every guard in
 * `recover.ts` matters — a page that cannot reach storage still has to render.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { pendingNote, recalledMode, rememberMode } from "./recover.ts";

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

afterEach(() => {
  // `restoreMocks` covers `vi.spyOn` and `unstubEnvs` covers `vi.stubEnv`;
  // neither covers a stubbed global, so this is the one teardown these specs
  // owe. Without it the first file to stub storage decides every later one.
  vi.unstubAllGlobals();
});

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

describe("pendingNote", () => {
  test("tells a streaming reader to keep the tab open, whoever started the run", () => {
    // First and unconditional: that run is reading the file from this page, so
    // a reload does not orphan it, it ends it. A page promising otherwise in
    // the mode it OPENS in would be the worst copy on the desk.
    const started = pendingNote({ recoverable: false, startedHere: true, found: true });
    expect(started).toMatch(/keep this tab open/i);
    expect(pendingNote({ recoverable: false, startedHere: false, found: false })).toBe(started);
  });

  test("promises the reload back to whoever pressed the button", () => {
    const note = pendingNote({ recoverable: true, startedHere: true, found: true });
    expect(note).toMatch(/reloading is safe/i);
  });

  test("says it is LOOKING while the lookup is still out", () => {
    const note = pendingNote({ recoverable: true, startedHere: false, found: false });
    expect(note).toMatch(/looking for/i);
  });

  test("explains a run the reader did not start, and says not to send it again", () => {
    // The line that stops a second 600 MB upload of the same recording, which
    // is what the key is for.
    const note = pendingNote({ recoverable: true, startedHere: false, found: true });
    expect(note).toMatch(/earlier/i);
    expect(note).toMatch(/no need to send it again/i);
  });

  test("says something different in each of its four situations", () => {
    const notes = [
      pendingNote({ recoverable: false, startedHere: true, found: true }),
      pendingNote({ recoverable: true, startedHere: true, found: true }),
      pendingNote({ recoverable: true, startedHere: false, found: false }),
      pendingNote({ recoverable: true, startedHere: false, found: true }),
    ];
    // A branch that duplicates its neighbour's sentence is a branch nobody can
    // see, and the four are the whole of what this page says about the wait.
    expect(new Set(notes).size).toBe(notes.length);
  });
});
