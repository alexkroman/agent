// Copyright 2026 the AAI authors. MIT license.

import type { SessionContextArgs } from "@alexkroman1/aai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import {
  MAX_REFUSE_REASON_CHARS,
  resolveSessionContext,
  SESSION_CONTEXT_TIMEOUT_MS,
} from "./session-context.ts";

const ARGS = { sessionId: "session-1234", clientId: "kitchen", env: { A: "1" } };

afterEach(() => vi.useRealTimers());

describe("resolveSessionContext", () => {
  test("no hook answers nothing and calls nothing", async () => {
    const logger = makeLogger();
    expect(await resolveSessionContext({ hook: undefined, args: ARGS, logger })).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("hands the hook the session, client, env and a live signal, and answers what it said", async () => {
    let seen: SessionContextArgs | undefined;
    const answer = await resolveSessionContext({
      hook: async (ctx) => {
        seen = ctx;
        return { instructions: "They like jazz.", historySince: 1000 };
      },
      args: ARGS,
      logger: makeLogger(),
    });
    expect(answer).toEqual({ instructions: "They like jazz.", historySince: 1000 });
    expect(seen).toMatchObject(ARGS);
    expect(seen?.signal.aborted).toBe(false);
  });

  test("a synchronous answer is taken too", async () => {
    const answer = await resolveSessionContext({
      hook: () => ({ instructions: "sync" }),
      args: ARGS,
      logger: makeLogger(),
    });
    expect(answer).toEqual({ instructions: "sync" });
  });

  test("a hook that outlives the deadline is abandoned, its signal aborted, and the session starts", async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    let signal: AbortSignal | undefined;
    const pending = resolveSessionContext({
      hook: (ctx) => {
        signal = ctx.signal;
        return new Promise(() => undefined);
      },
      args: ARGS,
      logger,
    });
    await vi.advanceTimersByTimeAsync(SESSION_CONTEXT_TIMEOUT_MS);
    expect(await pending).toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "sessionContext timed out; session starting without it",
      expect.objectContaining({ timeoutMs: SESSION_CONTEXT_TIMEOUT_MS }),
    );
  });

  test.each([
    ["a rejection", () => Promise.reject(new Error("memory service down"))],
    [
      "a synchronous throw",
      () => {
        throw new Error("memory service down");
      },
    ],
  ])("%s is a warning, never a failed start", async (_label, hook) => {
    const logger = makeLogger();
    expect(await resolveSessionContext({ hook, args: ARGS, logger })).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "sessionContext failed; session starting without it",
      expect.objectContaining({ error: "memory service down" }),
    );
  });

  test("fields of the wrong type are dropped, with a warning each, and the rest kept", async () => {
    const logger = makeLogger();
    const answer = await resolveSessionContext({
      // Author code crosses here untyped in practice (a JSON body passed through).
      hook: () => JSON.parse('{"instructions": 42, "historySince": "yesterday"}'),
      args: ARGS,
      logger,
    });
    expect(answer).toEqual({});
    expect(logger.warn).toHaveBeenCalledTimes(2);

    const notObject = await resolveSessionContext({
      hook: () => JSON.parse('"just text"'),
      args: ARGS,
      logger,
    });
    expect(notObject).toBeUndefined();
  });

  test("a location is held to the socket's rule, and a warning never names it", async () => {
    const clean = await resolveSessionContext({
      hook: () => ({ location: " 123 Example St,\n Portland " }),
      args: ARGS,
      logger: makeLogger(),
    });
    expect(clean).toEqual({ location: "123 Example St, Portland" });

    const logger = makeLogger();
    const unusable = await resolveSessionContext({
      hook: () => ({ location: "9 Long Rd ".repeat(40), instructions: "kept" }),
      args: ARGS,
      logger,
    });
    expect(unusable).toEqual({ instructions: "kept" });
    expect(logger.warn).toHaveBeenCalledWith(
      "sessionContext `location` is not a usable string; ignored",
      { sid: "session-" },
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("Long Rd");
  });

  test("a non-finite historySince is not a timestamp", async () => {
    const answer = await resolveSessionContext({
      hook: () => ({ historySince: Number.NaN }),
      args: ARGS,
      logger: makeLogger(),
    });
    expect(answer).toEqual({});
  });
});

describe("resolveSessionContext — refuse", () => {
  // Spelled as a PARSE rather than a cast: an answer crosses from author code,
  // and a `refuse` that is not a string is exactly what the check is for.
  const ask = (refuse: unknown, logger = makeLogger()) =>
    resolveSessionContext({
      hook: () => JSON.parse(JSON.stringify({ refuse })),
      args: ARGS,
      logger,
    });

  test("a reason is kept, trimmed, one line and capped", async () => {
    expect(await ask("  not a placed call ")).toEqual({ refuse: "not a placed call" });
    // A reason is one log line: a newline in it would forge a second one.
    expect(await ask("bad\nforged: line")).toEqual({ refuse: "bad forged: line" });
    const long = await ask("x".repeat(MAX_REFUSE_REASON_CHARS + 50));
    expect(long?.refuse).toHaveLength(MAX_REFUSE_REASON_CHARS);
  });

  test("an empty reason is no refusal, and a non-string is warned about and ignored", async () => {
    expect(await ask("   ")).toEqual({});
    const logger = makeLogger();
    expect(await ask(true, logger)).toEqual({});
    expect(logger.warn).toHaveBeenCalledWith(
      "sessionContext `refuse` is not a string; ignored",
      expect.anything(),
    );
  });
});
