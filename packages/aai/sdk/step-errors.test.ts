// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { FatalError, RetryableError } from "workflow";
import { TranscribeError } from "./_transcribe-shared.ts";
import { stepFetchOk, throwFatalStepError, throwStepError, toStepError } from "./step-errors.ts";
import { StepGenerateError } from "./step-generate.ts";

/**
 * The DevKit decides retry behaviour with `FatalError.is` / `RetryableError.is`,
 * both of which are NAME checks — an error crosses the journal, so `instanceof`
 * could not be the contract. Asserting the name as well as the class is
 * therefore asserting the thing the DevKit will actually read.
 */
function devKitVerdict(err: unknown): { fatal: boolean; retryable: boolean; retryAfter?: Date } {
  return {
    fatal: FatalError.is(err),
    retryable: RetryableError.is(err),
    ...(err instanceof RetryableError && err.retryAfter ? { retryAfter: err.retryAfter } : {}),
  };
}

/** A response carrying `status`, and a `Retry-After` when one is given. */
function responseWith(status: number, retryAfter?: string): Response {
  return new Response("{}", {
    status,
    headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
  });
}

describe("toStepError, given a Response", () => {
  test("makes a 4xx the DevKit will not retry FATAL", () => {
    const err = toStepError(responseWith(404), "GET /x failed: HTTP 404");

    expect(devKitVerdict(err)).toEqual({ fatal: true, retryable: false });
    expect(err.message).toBe("GET /x failed: HTTP 404");
  });

  test.each([408, 429, 500, 503])("makes a transient %i retryable", (status) => {
    expect(devKitVerdict(toStepError(responseWith(status), "nope"))).toMatchObject({
      fatal: false,
      retryable: true,
    });
  });

  test("carries the delay the far side asked for, rather than the DevKit's guess", () => {
    // The point of the whole classification: N segments hit one rate limit
    // together, and on our own backoff they re-collect their 429s N at a time.
    const err = toStepError(responseWith(429, "30"), "rate limited");

    const verdict = devKitVerdict(err);
    expect(verdict.retryable).toBe(true);
    expect(verdict.retryAfter?.getTime()).toBeGreaterThan(Date.now() + 25_000);
  });

  test("falls back to RetryableError's own one-second default when none was named", () => {
    // Not "the DevKit decides": the class always sets a date, and unset means
    // ONE SECOND. Worth pinning, because a fan-out that all retries a second
    // later is how a rate limit is turned into a tighter rate limit.
    const at = devKitVerdict(toStepError(responseWith(429), "rate limited")).retryAfter;

    expect(at?.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test("falls back to the status line when no message is given", () => {
    expect(toStepError(responseWith(503)).message).toBe("HTTP 503");
  });
});

describe("toStepError, given a StepGenerateError", () => {
  test("takes the gateway's own terminal verdict", () => {
    const err = toStepError(new StepGenerateError("bad key", { status: 401, retryable: false }));

    expect(devKitVerdict(err)).toEqual({ fatal: true, retryable: false });
    expect(err.message).toBe("bad key");
  });

  test("reads the retryAfter the error was already carrying", () => {
    // Nothing read this field before this module existed: both templates
    // re-threw the error unchanged, so a rate-limited model call fell back to
    // the default backoff with the gateway's own number sitting unread on it.
    const at = new Date(Date.now() + 45_000);
    const err = toStepError(
      new StepGenerateError("slow down", { status: 429, retryable: true, retryAfter: at }),
    );

    expect(devKitVerdict(err)).toMatchObject({ retryable: true, retryAfter: at });
  });
});

describe("toStepError, given a TranscribeError", () => {
  test("takes a PROVIDER refusal as terminal, where no status could say so", () => {
    // The case a status-based verdict cannot reach: the job came back 200 and
    // the provider said the recording could not be transcribed. Retrying asks
    // the same question and gets the same answer.
    const err = toStepError(
      new TranscribeError("no speech in that recording", { retryable: false }),
    );

    expect(devKitVerdict(err)).toEqual({ fatal: true, retryable: false });
    expect(err.message).toBe("no speech in that recording");
  });

  test("reads the delay a rate-limited endpoint asked for", () => {
    // Matters most on the sync endpoint, where a fan-out hits the limit all at
    // once: on the default backoff every segment asks again a second later.
    const at = new Date(Date.now() + 30_000);
    const err = toStepError(
      new TranscribeError("slow down", { status: 429, retryable: true, retryAfter: at }),
    );

    expect(devKitVerdict(err)).toMatchObject({ retryable: true, retryAfter: at });
  });
});

describe("toStepError, given anything else", () => {
  test("does NOT invent a verdict — an unclassifiable error passes through", () => {
    // The safe direction: the alternative is silently disabling retries for a
    // failure nobody classified.
    const original = new Error("something else went wrong");

    expect(toStepError(original)).toBe(original);
    expect(devKitVerdict(toStepError(original))).toMatchObject({
      fatal: false,
      retryable: false,
    });
  });

  test("wraps a non-Error, keeping it as the cause", () => {
    const err = toStepError("just a string");

    expect(err.message).toBe("just a string");
    expect(err.cause).toBe("just a string");
  });

  test("re-words an Error when a message is given, keeping the original as cause", () => {
    const original = new Error("inner");
    const err = toStepError(original, "outer");

    expect(err.message).toBe("outer");
    expect(err.cause).toBe(original);
  });
});

describe("throwStepError", () => {
  test("throws what toStepError returns, which is what makes it a .catch argument", async () => {
    const rejected = Promise.reject(
      new StepGenerateError("bad key", { status: 401, retryable: false }),
    );

    await expect(rejected.catch(throwStepError)).rejects.toSatisfy((err: unknown) =>
      FatalError.is(err),
    );
  });
});

/**
 * What `run` threw.
 *
 * A helper rather than a `try`/`catch` per test, and not only for brevity: the
 * functions under test return `never`, so a statement after a direct call is
 * unreachable and `tsc` says so (TS7027). Taking a thunk typed `() => unknown`
 * is what puts the assertion back on a reachable line.
 */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (err: unknown) {
    return err;
  }
  // A plain throw rather than `expect.fail`, which Biome (rightly) refuses
  // outside a test body: this helper is called from one, but the assertion
  // would be written here.
  throw new Error("expected a throw, got a return");
}

describe("throwFatalStepError", () => {
  test("stops the DevKit retrying whatever the cause was", () => {
    // The failure a step has DECIDED is terminal on grounds no status carries.
    const err = thrownBy(() => throwFatalStepError(new Error("ASSEMBLYAI_API_KEY is not set")));

    expect(FatalError.is(err)).toBe(true);
    expect((err as Error).message).toMatch(/ASSEMBLYAI_API_KEY/);
  });

  test("prefers an explicit message over the cause's own", () => {
    const err = thrownBy(() => throwFatalStepError(new Error("inner"), "cannot cut this"));

    expect((err as Error).message).toBe("cannot cut this");
  });
});

/**
 * `stepFetchOk` reaches the network through `stepFetch`, whose slot is
 * UNPUBLISHED in a spec — so it falls back to `globalThis.fetch`, which is
 * exactly the seam these cases stub. See `step-fetch.ts`'s module doc.
 */
describe("stepFetchOk", () => {
  const stubFetch = (response: Response) => {
    const fetch = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };

  test("returns the response untouched on 2xx, body unread", async () => {
    stubFetch(new Response("the body", { status: 200 }));

    const response = await stepFetchOk("https://api.test/thing");

    expect(response.status).toBe(200);
    // The success path must not consume the body — the caller chooses.
    expect(response.bodyUsed).toBe(false);
    await expect(response.text()).resolves.toBe("the body");
  });

  test("makes a 4xx FATAL, so the DevKit stops rather than asking three more times", async () => {
    stubFetch(new Response("nope", { status: 404 }));

    const err = await stepFetchOk("https://api.test/gone").catch((e: unknown) => e);

    expect(devKitVerdict(err)).toEqual({ fatal: true, retryable: false });
  });

  test("makes a 5xx RETRYABLE, honouring a Retry-After the server named", async () => {
    // On an exact second, because `Retry-After` has no sub-second resolution —
    // a date carrying milliseconds does not survive `toUTCString()` and the
    // comparison below would be off by one on roughly half of all runs.
    const at = new Date(Math.floor(Date.now() / 1000) * 1000 + 120_000);
    stubFetch(new Response("busy", { status: 503, headers: { "Retry-After": at.toUTCString() } }));

    const err = await stepFetchOk("https://api.test/busy").catch((e: unknown) => e);

    expect(devKitVerdict(err)).toMatchObject({ fatal: false, retryable: true });
    expect((err as RetryableError).retryAfter?.getTime()).toBe(at.getTime());
  });

  /** The half a hand-written `if (!res.ok)` throws away — see the doc. */
  test("carries the far side's own error text into the message", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: "podcast feed is not public" }), { status: 403 }),
    );

    const err = await stepFetchOk("https://api.test/feed").catch((e: unknown) => e);

    expect((err as Error).message).toBe("podcast feed is not public");
  });

  test("falls back to the request, the status and a body preview", async () => {
    stubFetch(new Response("<html>gateway timeout</html>", { status: 504 }));

    const err = await stepFetchOk("https://api.test/slow", { method: "POST" }).catch(
      (e: unknown) => e,
    );

    // The METHOD and URL, because a run's log holds many of these.
    expect((err as Error).message).toContain("POST https://api.test/slow");
    expect((err as Error).message).toContain("504");
    expect((err as Error).message).toContain("gateway timeout");
  });

  test("labels a request with no explicit method as GET", async () => {
    stubFetch(new Response("", { status: 500 }));

    const err = await stepFetchOk("https://api.test/x").catch((e: unknown) => e);

    expect((err as Error).message).toContain("GET https://api.test/x");
  });

  test("passes method, headers and body straight through to stepFetch", async () => {
    const fetch = stubFetch(new Response("ok", { status: 200 }));

    await stepFetchOk("https://api.test/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
    });

    expect(fetch).toHaveBeenCalledOnce();
  });
});
