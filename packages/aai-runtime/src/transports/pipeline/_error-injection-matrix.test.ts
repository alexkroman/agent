// Copyright 2026 the AAI authors. MIT license.
/**
 * The session-error table's own integrity: every `SessionErrorCode` is either
 * emitted by a declared site or declared client-minted, and every row says who
 * drives it. `error-injection.test.ts` is where the rows driven here are run.
 */

import { SessionErrorCodeSchema } from "@alexkroman1/aai/protocol";
import { describe, expect, test } from "vitest";
import {
  CLIENT_MINTED_CODES,
  drivenHere,
  SESSION_ERROR_SITES,
  unclassifiedCodes,
} from "./_error-injection-matrix.ts";

// ─── The gate ───────────────────────────────────────────────────────────────

describe("every session error code is classified", () => {
  /**
   * The sweep. A code is classified when some site row emits it, and otherwise
   * must be named in `CLIENT_MINTED_CODES` with a reason.
   *
   * Driven off `SessionErrorCodeSchema.options`, so this fails on the day a
   * code JOINS the union rather than on the day somebody notices.
   */
  test("no code is left without a site or a declaration", () => {
    expect(
      unclassifiedCodes(),
      "these codes are emitted by no declared site and are not declared client-minted. " +
        "Either add a row to SESSION_ERROR_SITES saying where the runtime emits one and " +
        "what the session does next, or add a CLIENT_MINTED_CODES entry saying why the " +
        "runtime never does. Silence is what every `fatal` bug in this family was.",
    ).toEqual([]);
  });

  /** Nothing in the declared map may be dead — an entry some row now emits. */
  test("no CLIENT_MINTED_CODES entry is stale", () => {
    const emitted = new Set<string>(SESSION_ERROR_SITES.map((s) => s.code));
    for (const [code, reason] of Object.entries(CLIENT_MINTED_CODES)) {
      expect(reason.length, `${code} needs a real reason`).toBeGreaterThan(30);
      expect(
        emitted.has(code),
        `${code} is now emitted by a declared site, so its CLIENT_MINTED_CODES entry says ` +
          "the opposite of what the runtime does. Remove it.",
      ).toBe(false);
    }
  });

  /**
   * A row that is not driven here has to name who drives it AND why this suite
   * cannot — the field exists because the failure mode of a table like this is
   * a row everybody believes and nothing runs.
   */
  test("every row that is not driven here names an owner and a reason", () => {
    for (const site of SESSION_ERROR_SITES) {
      if (site.driven === "here") continue;
      expect(site.driven.owner, `${site.site} needs an owner path`).toMatch(/^packages\//);
      expect(site.driven.why.length, `${site.site} needs a real reason`).toBeGreaterThan(40);
    }
  });

  /** Site ids are the driver table's keys, so a duplicate silently drops one. */
  test("site ids are unique", () => {
    const ids = SESSION_ERROR_SITES.map((s) => s.site);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The corpus floor. This whole suite's success output is a count, so a table
   * that emptied — a bad filter, a renamed export — would print the same green.
   */
  test("the table covers a corpus", () => {
    expect(SESSION_ERROR_SITES.length).toBeGreaterThan(10);
    expect(drivenHere().length).toBeGreaterThan(5);
    expect(SessionErrorCodeSchema.options.length).toBe(8);
  });
});
