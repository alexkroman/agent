// Copyright 2026 the AAI authors. MIT license.
/**
 * The accumulation policy for a session's own keyterms.
 *
 * Every assertion here is a decision that could defensibly have gone the other
 * way, which is why they are written down rather than left to the
 * implementation: what counts as a duplicate, which spelling survives one, and
 * which end of a full list drops.
 */

import { describe, expect, it } from "vitest";

import { createSessionKeyterms, SESSION_KEYTERM_LIMIT } from "./pipeline-session-keyterms.ts";

describe("createSessionKeyterms", () => {
  it("accumulates across calls, oldest first", () => {
    const k = createSessionKeyterms();
    k.add(["Yusuf"]);
    k.add(["Rossi", "W2378156"]);
    expect(k.current()).toEqual(["Yusuf", "Rossi", "W2378156"]);
  });

  it("is IDEMPOTENT — a term already held does not repeat or move", () => {
    // The property that makes this safe to call from a tool that runs every
    // turn: the provider skips an unchanged list, so a repeated hint costs
    // nothing on a socket that is also carrying audio.
    const k = createSessionKeyterms();
    k.add(["Yusuf", "Rossi"]);
    k.add(["Yusuf"]);
    expect(k.current()).toEqual(["Yusuf", "Rossi"]);
  });

  it("treats a case difference as the SAME term, keeping the first spelling", () => {
    // A name arrives from a database field and again from a caller spelling it
    // out. Two slots for one fact tells the recognizer nothing new, and
    // rewriting the spelling would cost a wire message for no change.
    const k = createSessionKeyterms();
    k.add(["Yusuf"]);
    k.add(["YUSUF", "yusuf"]);
    expect(k.current()).toEqual(["Yusuf"]);
  });

  it("drops blank and whitespace-only terms", () => {
    // The likely source is a tool interpolating a field that was absent; the
    // empty string biases nothing and would spend a slot.
    const k = createSessionKeyterms();
    k.add(["", "   ", "Rossi"]);
    expect(k.current()).toEqual(["Rossi"]);
  });

  it("trims, so a padded term and its bare twin are one", () => {
    const k = createSessionKeyterms();
    k.add([" Rossi "]);
    k.add(["Rossi"]);
    expect(k.current()).toEqual(["Rossi"]);
  });

  it("drops the OLDEST at the cap, so a long call can still learn", () => {
    // The alternative — refuse new terms once full — makes a call that has
    // been going a while permanently unable to learn the one fact it is
    // currently failing on.
    const k = createSessionKeyterms(3);
    k.add(["a", "b", "c"]);
    k.add(["d"]);
    expect(k.current()).toEqual(["b", "c", "d"]);
  });

  it("frees the dropped term's slot, so it can be re-added later", () => {
    // The bookkeeping half of the eviction: a term evicted and then learned
    // again is a NEW fact about this call, and must not be silently swallowed
    // by a stale duplicate check.
    const k = createSessionKeyterms(2);
    k.add(["a", "b", "c"]);
    expect(k.current()).toEqual(["b", "c"]);
    k.add(["a"]);
    expect(k.current()).toEqual(["c", "a"]);
  });

  it("defaults to a bound well under the service's own cap", () => {
    // Both halves share the provider's 100-term ceiling, so an unbounded
    // session list would crowd out the vocabulary the deployment shipped.
    const k = createSessionKeyterms();
    k.add(Array.from({ length: SESSION_KEYTERM_LIMIT + 10 }, (_, i) => `t${i}`));
    expect(k.current()).toHaveLength(SESSION_KEYTERM_LIMIT);
    expect(SESSION_KEYTERM_LIMIT).toBeLessThan(100);
  });
});
