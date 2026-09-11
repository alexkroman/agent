// Copyright 2026 the AAI authors. MIT license.
// The digest and its rendering. UNIT tier — nothing here touches the
// filesystem, a subprocess or the network, because the whole point of keeping
// the record a plain object over an array is that the gate's decision is
// testable without a model.

import { MAX_STATE_DIGEST_CHARS } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { createDigestStore } from "./digest.ts";

describe("createDigestStore", () => {
  test("opens nothing and says nothing", () => {
    const digest = createDigestStore();
    expect(digest.read()).toEqual({ revision: 0, summary: "", entries: [] });
    expect(digest.unsettled()).toEqual([]);
  });

  test("an opened entry is unsettled until it settles", () => {
    const digest = createDigestStore();
    digest.open("change_address", "w1");
    expect(digest.unsettled().map((e) => e.tool)).toEqual(["change_address"]);
    digest.settle("w1", "done", "");
    expect(digest.unsettled()).toEqual([]);
  });

  test("an UNVERIFIED entry is settled — the work happened", () => {
    // The distinction the rendering carries and the gate does not: it really
    // ran, so blocking completion on it forever would wedge the call.
    const digest = createDigestStore();
    digest.open("refund", "w1");
    digest.settle("w1", "unverified", "the review did not answer");
    expect(digest.unsettled()).toEqual([]);
    expect(digest.read().entries[0]?.state).toBe("unverified");
  });

  test("a REFUSED entry is settled too, for the same reason", () => {
    const digest = createDigestStore();
    digest.open("refund", "w1");
    digest.settle("w1", "refused", "not permitted");
    expect(digest.unsettled()).toEqual([]);
  });

  test("revision moves on every write and on nothing else", () => {
    const digest = createDigestStore();
    digest.open("x", "w1");
    const after = digest.read().revision;
    digest.read();
    digest.unsettled();
    expect(digest.read().revision).toBe(after);
    digest.settle("w1", "done", "");
    expect(digest.read().revision).toBeGreaterThan(after);
  });

  test("a BLANK summary leaves the last real one standing", () => {
    // A slow tier that answered a call and nothing else must not blank the
    // fast tier's only grounding.
    const digest = createDigestStore();
    digest.summarize("The address change is queued.");
    digest.summarize("   ");
    digest.summarize("");
    expect(digest.read().summary).toBe("The address change is queued.");
  });

  test("a summary is capped", () => {
    const digest = createDigestStore();
    digest.summarize("x".repeat(MAX_STATE_DIGEST_CHARS * 2));
    expect(digest.read().summary).toHaveLength(MAX_STATE_DIGEST_CHARS);
  });

  test("settling an id nothing opened is a no-op, not an append", () => {
    // It can only mean the entry was trimmed off a long call, and appending
    // would report the same work twice.
    const digest = createDigestStore();
    digest.settle("w404", "done", "");
    expect(digest.read().entries).toEqual([]);
    expect(digest.read().revision).toBe(0);
  });

  test("the entry list is bounded", () => {
    const digest = createDigestStore();
    for (let i = 0; i < 60; i += 1) digest.open(`t${i}`, `w${i}`);
    const { entries } = digest.read();
    expect(entries.length).toBeLessThanOrEqual(24);
    // The OLDEST go: the newest work is what the fast tier is asked about.
    expect(entries.at(-1)?.tool).toBe("t59");
  });

  test("read() hands back a copy", () => {
    const digest = createDigestStore();
    digest.open("x", "w1");
    const snapshot = digest.read();
    digest.open("y", "w2");
    expect(snapshot.entries).toHaveLength(1);
  });
});
