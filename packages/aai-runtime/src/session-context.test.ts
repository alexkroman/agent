// Copyright 2026 the AAI authors. MIT license.

import type { SessionContextArgs } from "@alexkroman1/aai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { resolveSessionContext, SESSION_CONTEXT_TIMEOUT_MS } from "./session-context.ts";

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

  test("a non-finite historySince is not a timestamp", async () => {
    const answer = await resolveSessionContext({
      hook: () => ({ historySince: Number.NaN }),
      args: ARGS,
      logger: makeLogger(),
    });
    expect(answer).toEqual({});
  });
});
