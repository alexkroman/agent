// Copyright 2026 the AAI authors. MIT license.
/**
 * `toStepError` and the two throwing forms over it — the classifier every
 * `/step` caller's failure goes through. Moved here from `step-errors.test.ts`,
 * which keeps what `step-errors.ts` itself adds (`throwFfmpegStepError`, the
 * `orFail` callers); `stepVerdict` and `thrownBy` are duplicated rather than
 * shared because both files are their only readers.
 */
import { describe, expect, test } from "vitest";
import { freezeDate } from "../host/_test-utils.ts";
import { throwFatalStepError, throwStepError, toStepError } from "./_step-verdict.ts";
import { TranscribeError } from "./_transcribe-shared.ts";
import { FatalError, RetryableError } from "./step-error-classes.ts";
import { StepGenerateError } from "./step-generate.ts";

/**
 * The verdict as the ENGINE reads it — `FatalError.is` / `RetryableError.is`,
 * never `instanceof`.
 *
 * Both statics read a branding symbol rather than the prototype chain, because a
 * guest bundle can hold two copies of `step-error-classes.ts` and `instanceof`
 * answers false across them. Asserting through the statics is therefore
 * asserting the thing `workflow/replay.ts` will actually ask, which is the whole
 * point of the helper: a classifier that produced an error only `instanceof`
 * recognised would pass a spec written the other way and silently retry a
 * `FatalError` in production.
 */
function stepVerdict(err: unknown): { fatal: boolean; retryable: boolean; retryAfter?: Date } {
  return {
    fatal: FatalError.is(err),
    retryable: RetryableError.is(err),
    // `retryAfter` is a non-optional `Date` the constructor always assigns, so
    // membership is the only question — no truthiness guard.
    ...(RetryableError.is(err) ? { retryAfter: err.retryAfter } : {}),
  };
}

/** A response carrying `status`, and a `Retry-After` when one is given. */
function responseWith(status: number, retryAfter?: string): Response {
  return new Response("{}", {
    status,
    headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
  });
}

/**
 * A response as it arrives from ANOTHER REALM — the case every step body is in.
 *
 * A real cross-realm `Response` cannot be built inside one process: it takes a
 * second realm with its own undici, which is what a step bundle running
 * in a `node:vm` context has and a test does not. What CAN be reproduced is the
 * only property that matters — the object answers `status`, `ok` and
 * `headers.get` and is not an `instanceof Response` — so that is what this
 * builds, with a real `Headers` inside it because the reading of the header is
 * not the part under test.
 *
 * The real thing was measured inside a step bundle under `aai dev`:
 * `{ instanceofResponse: false, ctor: "Response", realmTag: "[object Response]",
 * globalResponseIsSame: true }`. Every response a step is handed looked like
 * that, so every one of them fell through `toStepError`'s classification.
 */
function responseFromAnotherRealm(
  status: number,
  retryAfter?: string,
): {
  status: number;
  ok: boolean;
  headers: Headers;
} {
  const headers = new Headers(retryAfter === undefined ? {} : { "Retry-After": retryAfter });
  // Not a `Response`, and that IS the fixture: `instanceof` must not be what
  // recognises it. NO cast — `toStepError` takes `unknown`, so the honest type
  // here is the shape itself, and a cast to `Response` would be the fixture
  // claiming to be the thing whose identity is under test.
  return { status, ok: status >= 200 && status < 300, headers };
}

describe("toStepError, given a Response", () => {
  test("makes a 4xx the engine will not retry FATAL", () => {
    const err = toStepError(responseWith(404), "GET /x failed: HTTP 404");

    expect(stepVerdict(err)).toEqual({ fatal: true, retryable: false });
    expect(err.message).toBe("GET /x failed: HTTP 404");
  });

  test("keeps the response itself as the cause, headers and status included", () => {
    // A sentence is what the journal keeps, and it is not what the process that
    // threw this has to debug with: the status and the headers the verdict was
    // DERIVED from are on the response, and `orFail(stepFetch)` has already read the
    // body by the time it hands one over.
    const refused = new Response("nope", { status: 403 });
    expect(toStepError(refused, "GET /orders: HTTP 403").cause).toBe(refused);

    const busy = new Response("later", { status: 503 });
    expect(toStepError(busy).cause).toBe(busy);
  });

  test("classifies a response from ANOTHER REALM, which is every step's case", () => {
    // The regression, and the reason this is the first assertion after the
    // ordinary 404: `cause instanceof Response` is FALSE for the response a
    // step body is handed, so every one of them fell through to the plain-Error
    // arm and the DevKit retried a 401 three times with its own 1s default.
    const foreign = responseFromAnotherRealm(401);
    expect(stepVerdict(toStepError(foreign, "GET /x failed: HTTP 401"))).toEqual({
      fatal: true,
      retryable: false,
    });
  });

  test("reads a foreign response's Retry-After, so the far side's delay survives", () => {
    // The other half of the same bug: transient was reachable by luck (an
    // unclassified error retries too) but the DELAY was not, so a rate limit
    // asking for 5s got the DevKit's 1s and N siblings all asked again at once.
    const now = freezeDate();
    const err = toStepError(responseFromAnotherRealm(503, "5"), "nope");
    const verdict = stepVerdict(err);
    expect(verdict).toMatchObject({ fatal: false, retryable: true });
    // The header is seconds and the error carries a Date.
    expect(verdict.retryAfter?.getTime()).toBe(now + 5000);
  });

  test.each([408, 429, 500, 503])("makes a transient %i retryable", (status) => {
    expect(stepVerdict(toStepError(responseWith(status), "nope"))).toMatchObject({
      fatal: false,
      retryable: true,
    });
  });

  test("carries the delay the far side asked for, rather than the class's own default", () => {
    // The point of the whole classification: N segments hit one rate limit
    // together, and on our own backoff they re-collect their 429s N at a time.
    const now = freezeDate();
    const err = toStepError(responseWith(429, "30"), "rate limited");

    const verdict = stepVerdict(err);
    expect(verdict.retryable).toBe(true);
    expect(verdict.retryAfter?.getTime()).toBe(now + 30_000);
  });

  test("falls back to RetryableError's own one-second default when none was named", () => {
    // Not "the engine decides": the class always sets a date, and unset means
    // ONE SECOND. Worth pinning, because a fan-out that all retries a second
    // later is how a rate limit is turned into a tighter rate limit.
    const now = freezeDate();
    const at = stepVerdict(toStepError(responseWith(429), "rate limited")).retryAfter;

    expect(at?.getTime()).toBe(now + 1000);
  });

  test("falls back to the status line when no message is given", () => {
    expect(toStepError(responseWith(503)).message).toBe("HTTP 503");
  });
});

describe("toStepError, given a StepGenerateError", () => {
  test("takes the gateway's own terminal verdict", () => {
    const err = toStepError(new StepGenerateError("bad key", { status: 401, retryable: false }));

    expect(stepVerdict(err)).toEqual({ fatal: true, retryable: false });
    expect(err.message).toBe("bad key");
  });

  test("keeps the gateway's error as the cause, message replaced and all", () => {
    // The same drop as `throwFatalStepError`'s below, one arm over: a cause that
    // already carried its own verdict was read for `retryable`/`retryAfter` and
    // then discarded, so a step that re-worded the failure — which is what the
    // `message` parameter is for — left nothing behind saying what the far side
    // had actually said.
    const cause = new StepGenerateError("bad key", { status: 401, retryable: false });
    expect(toStepError(cause, "the recap could not be written").cause).toBe(cause);

    const slow = new StepGenerateError("slow down", { status: 429, retryable: true });
    expect(toStepError(slow).cause).toBe(slow);
  });

  test("reads the retryAfter the error was already carrying", () => {
    // Nothing read this field before this module existed: both templates
    // re-threw the error unchanged, so a rate-limited model call fell back to
    // the default backoff with the gateway's own number sitting unread on it.
    const at = new Date(Date.now() + 45_000);
    const err = toStepError(
      new StepGenerateError("slow down", { status: 429, retryable: true, retryAfter: at }),
    );

    expect(stepVerdict(err)).toMatchObject({ retryable: true, retryAfter: at });
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

    expect(stepVerdict(err)).toEqual({ fatal: true, retryable: false });
    expect(err.message).toBe("no speech in that recording");
  });

  test("reads the delay a rate-limited endpoint asked for", () => {
    // Matters most on the sync endpoint, where a fan-out hits the limit all at
    // once: on the default backoff every segment asks again a second later.
    const at = new Date(Date.now() + 30_000);
    const err = toStepError(
      new TranscribeError("slow down", { status: 429, retryable: true, retryAfter: at }),
    );

    expect(stepVerdict(err)).toMatchObject({ retryable: true, retryAfter: at });
  });

  test("reads a verdict off an error REHYDRATED from the journal", () => {
    // The case `instanceof` cannot reach, and the reason the check is
    // structural. `toStepError` runs inside step bodies, where a
    // failure can come back through the durable journal as a plain object with
    // no prototype — under an `instanceof` chain this fell through to "no
    // verdict available" and a terminal refusal came back out RETRYABLE, so the
    // run asked the same unanswerable question until it exhausted its attempts.
    const err = toStepError({
      message: "no speech in that recording",
      retryable: false,
      retryAfter: undefined,
    });

    expect(stepVerdict(err)).toEqual({ fatal: true, retryable: false });
    expect(err.message).toBe("no speech in that recording");
  });
});

describe("toStepError, given anything else", () => {
  test("does NOT invent a verdict — an unclassifiable error passes through", () => {
    // The safe direction: the alternative is silently disabling retries for a
    // failure nobody classified.
    const original = new Error("something else went wrong");

    expect(toStepError(original)).toBe(original);
    expect(stepVerdict(toStepError(original))).toMatchObject({
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
  test("stops the engine retrying whatever the cause was", () => {
    // The failure a step has DECIDED is terminal on grounds no status carries.
    const err = thrownBy(() => throwFatalStepError(new Error("ASSEMBLYAI_API_KEY is not set")));

    expect(err).toSatisfy(FatalError.is);
    expect((err as Error).message).toMatch(/ASSEMBLYAI_API_KEY/);
  });

  test("prefers an explicit message over the cause's own", () => {
    const err = thrownBy(() => throwFatalStepError(new Error("inner"), "cannot cut this"));

    expect((err as Error).message).toBe("cannot cut this");
  });

  test("carries the ORIGINAL failure, not a sentence taken off it", () => {
    // The documented shape is `catch (err) { return throwFatalStepError(err) }`,
    // so what a step is holding when it calls this is the real failure —
    // stack, chain and all — and it used to reach the engine as one bare
    // sentence with the rest dropped on the floor. Asserted as IDENTITY, and
    // with the message REPLACED, which is the case where the drop lost
    // everything: the original's own words are gone from the message too, so
    // the chain is all that is left of what happened.
    const root = new Error("EAI_AGAIN api.assemblyai.com");
    const inner = new Error("the provider could not be reached", { cause: root });
    const err = thrownBy(() => throwFatalStepError(inner, "cannot cut this")) as Error;

    expect(err.cause).toBe(inner);
    expect((err.cause as Error).cause).toBe(root);
    // The stack the sentence cannot carry — the whole point of keeping the
    // instance rather than copying a string off it.
    expect((err.cause as Error).stack).toBe(inner.stack);
  });
});
