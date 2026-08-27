// Copyright 2026 the AAI authors. MIT license.
/**
 * Per-tenant stream names.
 *
 * This is a security fix rather than tidiness, and the reason is in the source:
 * `@workflow/world-postgres`'s `readFromStream` looks a stream up by NAME ALONE
 * (`where(eq(streams.streamId, name))`, no run filter) and its live fan-out keys on
 * `strm:${name}` the same way. With every agent's streams in one schema, two agents
 * that pick the same name share a stream — and no check at the HTTP layer closes
 * that, because their query cannot tell the two apart.
 *
 * So what is asserted here is a ROUND TRIP that is exact for every name a caller
 * might choose, including the ones that look like they would break it.
 */

import { describe, expect, test } from "vitest";
import { qualifyStreamName, unqualifyStreamName } from "./workflow-stream-namespace.ts";

describe("the round trip", () => {
  test.each([
    ["a plain name", "output"],
    ["dots and dashes", "run.output-2"],
    ["a name containing the separator", "nested/path/name"],
    ["a name that looks like another agent's", "other-agent/output"],
    ["a name that is just the separator", "/"],
    ["a unicode name", "résumé-stream"],
    ["a very long name", "x".repeat(500)],
  ])("is exact for %s", (_label, name) => {
    const qualified = qualifyStreamName("my-agent", name);
    expect(unqualifyStreamName("my-agent", qualified)).toBe(name);
  });

  test("an empty name round-trips, since the caller's grammar is not ours", () => {
    // `decideScope` refuses an empty name before this is reached; the codec still
    // has to be total, because a partial one invites a caller to special-case it.
    expect(unqualifyStreamName("my-agent", qualifyStreamName("my-agent", ""))).toBe("");
  });
});

describe("the boundary", () => {
  test("qualifies with the slug and a separator that is not a slug character", () => {
    // `/` is not in `SLUG_PATTERN_SOURCE`, so the FIRST one is always the boundary
    // — while the NAME may contain any number of them.
    expect(qualifyStreamName("my-agent", "output")).toBe("my-agent/output");
  });

  /**
   * The assertion that makes the namespacing worth anything.
   *
   * Two agents choosing the same stream name must produce different keys, or their
   * global-by-name lookup finds one stream for both.
   */
  test("two agents with the SAME name get different keys", () => {
    expect(qualifyStreamName("mine", "output")).not.toBe(qualifyStreamName("theirs", "output"));
  });

  test("one agent cannot forge another's key by choosing a clever name", () => {
    // A caller who names their stream `theirs/output` gets `mine/theirs/output` —
    // which unqualifies for `mine` and NOT for `theirs`, because the prefix is
    // matched at the start rather than searched for.
    const forged = qualifyStreamName("mine", "theirs/output");
    expect(forged).toBe("mine/theirs/output");
    expect(unqualifyStreamName("theirs", forged)).toBeUndefined();
    expect(unqualifyStreamName("mine", forged)).toBe("theirs/output");
  });
});

describe("unqualifying something that is not this agent's", () => {
  /**
   * Undefined, never the raw value.
   *
   * A name without this agent's prefix is a name from somewhere else. Returning it
   * would hand back a value this code cannot attribute — and the caller drops it,
   * which is the right way to find out an invariant broke.
   */
  test.each([
    ["another agent's key", "theirs/output"],
    ["an unqualified name", "output"],
    ["the empty string", ""],
    ["a prefix that only looks right", "my-agent-2/output"],
    ["the slug with no separator", "my-agent"],
  ])("declines %s", (_label, qualified) => {
    expect(unqualifyStreamName("my-agent", qualified)).toBeUndefined();
  });

  test("a slug that is a PREFIX of another does not collide", () => {
    // `my` and `my-agent` are both legal slugs, and a `startsWith` on the slug
    // alone would let one read the other's streams. The separator is what stops it.
    const mine = qualifyStreamName("my", "output");
    expect(unqualifyStreamName("my-agent", mine)).toBeUndefined();
    expect(unqualifyStreamName("my", mine)).toBe("output");
  });
});
