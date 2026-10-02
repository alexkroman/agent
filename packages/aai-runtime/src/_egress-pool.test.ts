// Copyright 2026 the AAI authors. MIT license.
/**
 * `createEgressPool`: the options a caller states are the options the undici
 * pool is built with — `allowH2` defaulting to `false`, and the two timeouts
 * OMITTED rather than passed as `undefined` when a caller leaves them out.
 *
 * Read off undici's own `options` slot (a symbol, found by description) rather
 * than through a mocked constructor: no request is made, and nothing is faked.
 */

import { Agent } from "undici";
import { describe, expect, test } from "vitest";
import { createEgressPool } from "./_egress-pool.ts";

const SIZING = { connections: 4, keepAliveTimeout: 1000, pipelining: 1 };

/** The options undici recorded for this agent. */
function builtWith(dispatcher: unknown): Record<string, unknown> {
  if (!(dispatcher instanceof Agent)) throw new Error("the dispatcher is not an undici Agent");
  const key = Object.getOwnPropertySymbols(dispatcher).find((s) => s.description === "options");
  if (key === undefined) throw new Error("undici's Agent no longer records an `options` slot");
  return Reflect.get(dispatcher, key);
}

describe("createEgressPool", () => {
  test("pins HTTP/1.1 unless the caller says otherwise", async () => {
    const pool = createEgressPool(SIZING);
    expect(builtWith(pool.dispatcher)).toMatchObject({ allowH2: false, ...SIZING });
    await pool.close();
  });

  test("an explicit allowH2 is honoured", async () => {
    const pool = createEgressPool({ ...SIZING, allowH2: true, pipelining: 16 });
    expect(builtWith(pool.dispatcher)).toMatchObject({ allowH2: true, pipelining: 16 });
    await pool.close();
  });

  test("leaves undici's timeouts unset when omitted, and passes them when stated", async () => {
    const defaults = createEgressPool(SIZING);
    const options = builtWith(defaults.dispatcher);
    expect(Object.hasOwn(options, "headersTimeout")).toBe(false);
    expect(Object.hasOwn(options, "bodyTimeout")).toBe(false);

    const raised = createEgressPool({ ...SIZING, headersTimeout: 60_000, bodyTimeout: 90_000 });
    expect(builtWith(raised.dispatcher)).toMatchObject({
      headersTimeout: 60_000,
      bodyTimeout: 90_000,
    });
    await Promise.all([defaults.close(), raised.close()]);
  });

  test("close drains and closes the pool", async () => {
    const pool = createEgressPool(SIZING);
    const agent = pool.dispatcher;
    if (!(agent instanceof Agent)) throw new Error("expected an undici Agent");
    expect(agent.closed).toBe(false);
    await pool.close();
    expect(agent.closed).toBe(true);
  });
});
