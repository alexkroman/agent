// Copyright 2026 the AAI authors. MIT license.
/**
 * Which database the self-hosted door owes tables to, and how often it says so.
 *
 * That the tables really appear is a claim about a CATALOG and lives in
 * `self-hosted-schema.scenario.test.ts`, over a real Postgres. Everything
 * decidable without one is here: the branch in front of the applier, and the
 * memo that keeps `aai dev`'s per-save rebuild from re-issuing eight statements
 * on every file save.
 *
 * The applier is reached through a URL nothing is listening on, which is what
 * keeps this unit-tier: `ECONNREFUSED` on loopback, measured at 24ms, where a
 * firewalled host would sit on postgres.js's 30s connect timeout. What that
 * buys is that the applier's own warn-rather-than-throw contract is asserted
 * here rather than assumed — a self-hosted role that may not CREATE has to keep
 * booting.
 */

import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { ensureOwnedSchemas, ownedSchemaUrl } from "./agent-server-schemas.ts";

describe("ownedSchemaUrl", () => {
  test("no DATABASE_URL, nothing owned", () => {
    expect(ownedSchemaUrl({ env: { ASSEMBLYAI_API_KEY: "sk-test" } })).toBeUndefined();
  });

  test("the agent's own env is read when there is no providerEnv", () => {
    expect(ownedSchemaUrl({ env: { DATABASE_URL: "postgres://app@db/x" } })).toBe(
      "postgres://app@db/x",
    );
  });

  test("providerEnv WINS, because that is the env the runtime opens its pool from", () => {
    // `createRuntime` resolves `providerEnv ?? env` and opens the pool from
    // that, so reading `env` here would provision one database while the stores
    // read another — with both boot lines reporting `postgres`.
    expect(
      ownedSchemaUrl({
        env: { DATABASE_URL: "postgres://app@declared/x" },
        providerEnv: { DATABASE_URL: "postgres://app@host-fallback/x" },
      }),
    ).toBe("postgres://app@host-fallback/x");
  });

  test("whitespace is not a database", () => {
    // A `DATABASE_URL=` line in a `.env` arrives as an empty string, and an
    // empty pool URL is not a deployment that owns anything.
    expect(ownedSchemaUrl({ env: { DATABASE_URL: "   " } })).toBeUndefined();
  });

  test("a PLATFORM guest owns nothing here, whatever DATABASE_URL it also carries", () => {
    // Both keys or neither — `resolvePlatformQueue` refuses to resolve a
    // half-configured environment. On a platform both stores are the
    // platform's own, ahead of any `DATABASE_URL` an author also set, so tables
    // created in the tenant's database would be read by nobody.
    vi.stubEnv("AAI_PLATFORM_BASE_URL", "http://127.0.0.1:1/slug");
    vi.stubEnv("AAI_GUEST_TOKEN", "guest-token");

    expect(ownedSchemaUrl({ env: { DATABASE_URL: "postgres://app@db/x" } })).toBeUndefined();
  });
});

describe("ensureOwnedSchemas", () => {
  /** A URL nothing is listening on, unique per case so the memo cannot hide one. */
  const dead = (name: string) => `postgres://nobody@127.0.0.1:1/${name}`;

  test("a database nothing answers WARNS and resolves, so a boot is never failed", async () => {
    const logger = makeLogger();

    await expect(ensureOwnedSchemas(dead("unreachable"), logger)).resolves.toBeUndefined();

    // BOTH appliers ran, matched on each one's own wording: the session-state
    // half names the tables in the message and the journal half names the
    // subsystem, so a shared phrase would assert about one of them.
    const said = logger.warn.mock.calls.map(([message]) => String(message));
    expect(said.some((line) => /aai_session_state/.test(line))).toBe(true);
    expect(said.some((line) => /Workflow journal schema not applied/.test(line))).toBe(true);
  });

  test("a second call is the SAME work, not a second round of it", async () => {
    const logger = makeLogger();
    const url = dead("memoized");

    const first = ensureOwnedSchemas(url, logger);
    // Identity, which is the strong form: a "done" flag would let a door that
    // boots mid-apply race the first one instead of awaiting it, and that door
    // is `aai dev`'s next file save.
    expect(ensureOwnedSchemas(url, logger)).toBe(first);
    await first;
    // And once settled it is still not re-issued.
    await ensureOwnedSchemas(url, logger);

    const attempts = logger.warn.mock.calls.filter(([message]) =>
      /aai_session_state/.test(String(message)),
    );
    expect(attempts).toHaveLength(1);
  });

  test("a DIFFERENT database is still provisioned — the memo is per URL", async () => {
    const logger = makeLogger();

    const one = ensureOwnedSchemas(dead("first"), logger);
    expect(ensureOwnedSchemas(dead("second"), logger)).not.toBe(one);
  });
});
