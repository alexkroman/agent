// Copyright 2026 the AAI authors. MIT license.
/**
 * The trace-context grammar, from both ends.
 *
 * What is worth pinning is the REFUSALS. This value is a log field and a join
 * key, so a malformed header that parsed to something plausible is worse than
 * one that parsed to nothing: a junk id sits beside real ones and a search for
 * it answers lines from unrelated requests. The successes are one shape.
 */

import { describe, expect, test } from "vitest";
import { newTraceparent, parseTraceparent, traceIdOf } from "./_trace-context.ts";

describe("newTraceparent", () => {
  test("is a header the parser accepts, which is the only contract that matters", () => {
    // Asserted as a ROUND TRIP rather than against a regex copied from the
    // source: a minter and a parser that disagree is the one failure mode here,
    // and a second copy of the pattern cannot detect it.
    const header = newTraceparent();
    expect(traceIdOf(header)).toBeDefined();
    expect(header).toContain(traceIdOf(header) as string);
  });

  test("is 55 characters of the W3C shape, so a collector reads it for free", () => {
    expect(newTraceparent()).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  test("mints a fresh trace per call — one span per RPC, by design", () => {
    const ids = new Set(Array.from({ length: 50 }, () => traceIdOf(newTraceparent())));
    expect(ids.size).toBe(50);
  });
});

describe("traceIdOf", () => {
  test("reads the trace id out of a well-formed header", () => {
    expect(traceIdOf("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBe(
      "4bf92f3577b34da6a3ce929d0e0e4736",
    );
  });

  test("a sampling flag of 00 still carries a usable id", () => {
    // The flag says whether to RECORD; it says nothing about whether the id is
    // real. Dropping the id here would lose the join for any caller that ever
    // grows a sampler.
    expect(traceIdOf("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00")).toBe(
      "4bf92f3577b34da6a3ce929d0e0e4736",
    );
  });

  test.each([
    ["absent", undefined],
    ["null, as a header reader answers", null],
    ["empty", ""],
    ["a version nothing can emit yet", "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"],
    ["a short trace id", "00-4bf92f3577b34da6-00f067aa0ba902b7-01"],
    ["a short span id", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa-01"],
    [
      "upper-case hex, which the spec forbids",
      "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
    ],
    ["non-hex", "00-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-00f067aa0ba902b7-01"],
    [
      "an all-zero trace id, which the spec makes invalid",
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
    ],
    ["an all-zero span id", "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"],
    ["trailing junk", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01 "],
    ["a whole other header's value", "Bearer abc"],
  ] as const)("refuses %s rather than repairing it", (_label, header) => {
    expect(traceIdOf(header)).toBeUndefined();
  });
});

describe("parseTraceparent", () => {
  test("keeps the span id and the flags, which is what a PARENT needs", () => {
    // `traceIdOf` answers the log field. A span needs the CALLER's span id too,
    // or the exported span carries a matching string rather than being a real
    // child of the request that produced it.
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      flags: 1,
    });
  });

  test("reads the flags BYTE rather than assuming the sampled bit", () => {
    const flagsOf = (byte: string) =>
      parseTraceparent(`00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-${byte}`)?.flags;
    expect(flagsOf("00")).toBe(0);
    expect(flagsOf("ff")).toBe(255);
  });

  test("agrees with `traceIdOf` on every header, which is the whole point", () => {
    // ONE parser, so a log line and an exported span can never name two
    // different traces for one request — see `aai-server/tracing-propagator.ts`.
    for (const header of [
      newTraceparent(),
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "Bearer abc",
      "",
    ]) {
      expect.soft(parseTraceparent(header)?.traceId, header).toBe(traceIdOf(header));
    }
  });

  test("refuses a null or absent header, as the log field does", () => {
    expect(parseTraceparent(null)).toBeUndefined();
    expect(parseTraceparent(undefined)).toBeUndefined();
  });
});
