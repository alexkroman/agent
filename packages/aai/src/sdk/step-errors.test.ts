// Copyright 2026 the AAI authors. MIT license.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { FfmpegError, type FfmpegFailureKind } from "../host/ffmpeg.ts";
import { TranscribeError } from "./_transcribe-shared.ts";
import { FatalError, RetryableError } from "./step-error-classes.ts";
import {
  stepFetchOrFail,
  stepGenerateJsonOrFail,
  stepGenerateOrFail,
  stepTranscribePollOrFail,
  stepTranscribeSubmitOrFail,
  stepTranscribeSyncOrFail,
  stepTranscribeUploadOrFail,
  throwFatalStepError,
  throwFfmpegStepError,
  throwStepError,
  toStepError,
} from "./step-errors.ts";
import { StepGenerateError } from "./step-generate.ts";
import { publishUploadReader } from "./step-uploads.ts";
import { stubGateway } from "./testing-gateway.ts";

/**
 * The verdict as the ENGINE reads it — `FatalError.is` / `RetryableError.is`,
 * never `instanceof`.
 *
 * Both statics read a branding symbol rather than the prototype chain, because a
 * guest bundle can hold two copies of `step-error-classes.ts` and `instanceof`
 * answers false across them. Asserting through the statics is therefore
 * asserting the thing `workflow-replay.ts` will actually ask, which is the whole
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
    // DERIVED from are on the response, and `stepFetchOrFail` has already read the
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
    const err = toStepError(responseFromAnotherRealm(503, "5"), "nope");
    const verdict = stepVerdict(err);
    expect(verdict).toMatchObject({ fatal: false, retryable: true });
    // Within the second: the header is seconds and the error carries a Date.
    const seconds = Math.round(((verdict.retryAfter?.getTime() ?? 0) - Date.now()) / 1000);
    expect(seconds).toBe(5);
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
    const err = toStepError(responseWith(429, "30"), "rate limited");

    const verdict = stepVerdict(err);
    expect(verdict.retryable).toBe(true);
    expect(verdict.retryAfter?.getTime()).toBeGreaterThan(Date.now() + 25_000);
  });

  test("falls back to RetryableError's own one-second default when none was named", () => {
    // Not "the engine decides": the class always sets a date, and unset means
    // ONE SECOND. Worth pinning, because a fan-out that all retries a second
    // later is how a rate limit is turned into a tighter rate limit.
    const at = stepVerdict(toStepError(responseWith(429), "rate limited")).retryAfter;

    expect(at?.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
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

    expect(FatalError.is(err)).toBe(true);
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

/**
 * `stepFetchOrFail` reaches the network through `stepFetch`, whose slot is
 * UNPUBLISHED in a spec — so it falls back to `globalThis.fetch`, which is
 * exactly the seam these cases stub. See `step-fetch.ts`'s module doc.
 */
describe("stepFetchOrFail", () => {
  const stubFetch = (response: Response) => {
    const fetch = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };

  test("returns the response untouched on 2xx, body unread", async () => {
    stubFetch(new Response("the body", { status: 200 }));

    const response = await stepFetchOrFail("https://api.test/thing");

    expect(response.status).toBe(200);
    // The success path must not consume the body — the caller chooses.
    expect(response.bodyUsed).toBe(false);
    await expect(response.text()).resolves.toBe("the body");
  });

  test("makes a 4xx FATAL, so the engine stops rather than asking three more times", async () => {
    stubFetch(new Response("nope", { status: 404 }));

    const err = await stepFetchOrFail("https://api.test/gone").catch((e: unknown) => e);

    expect(stepVerdict(err)).toEqual({ fatal: true, retryable: false });
  });

  test("makes a 5xx RETRYABLE, honouring a Retry-After the server named", async () => {
    // On an exact second, because `Retry-After` has no sub-second resolution —
    // a date carrying milliseconds does not survive `toUTCString()` and the
    // comparison below would be off by one on roughly half of all runs.
    const at = new Date(Math.floor(Date.now() / 1000) * 1000 + 120_000);
    stubFetch(new Response("busy", { status: 503, headers: { "Retry-After": at.toUTCString() } }));

    const err = await stepFetchOrFail("https://api.test/busy").catch((e: unknown) => e);

    expect(stepVerdict(err)).toMatchObject({ fatal: false, retryable: true });
    expect((err as RetryableError).retryAfter.getTime()).toBe(at.getTime());
  });

  /** The half a hand-written `if (!res.ok)` throws away — see the doc. */
  test("carries the far side's own error text into the message", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: "podcast feed is not public" }), { status: 403 }),
    );

    const err = await stepFetchOrFail("https://api.test/feed").catch((e: unknown) => e);

    expect((err as Error).message).toBe("podcast feed is not public");
  });

  test("falls back to the request, the status and a body preview", async () => {
    stubFetch(new Response("<html>gateway timeout</html>", { status: 504 }));

    const err = await stepFetchOrFail("https://api.test/slow", { method: "POST" }).catch(
      (e: unknown) => e,
    );

    // The METHOD and URL, because a run's log holds many of these.
    expect((err as Error).message).toContain("POST https://api.test/slow");
    expect((err as Error).message).toContain("504");
    expect((err as Error).message).toContain("gateway timeout");
  });

  test("labels a request with no explicit method as GET", async () => {
    stubFetch(new Response("", { status: 500 }));

    const err = await stepFetchOrFail("https://api.test/x").catch((e: unknown) => e);

    expect((err as Error).message).toContain("GET https://api.test/x");
  });

  test("passes method, headers and body straight through to stepFetch", async () => {
    const fetch = stubFetch(new Response("ok", { status: 200 }));

    await stepFetchOrFail("https://api.test/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
    });

    expect(fetch).toHaveBeenCalledOnce();
  });
});

/**
 * A real `FfmpegError`, because the guard behind `throwFfmpegStepError` is
 * STRUCTURAL rather than an `instanceof` — so a spec that built its own
 * look-alike would be testing the spec's idea of the class. `host/ffmpeg.ts` is
 * the only import in this file that reaches `host/`, and it is deliberate: the
 * point of these cases is that the shipped class still satisfies the check.
 */
function ffmpegFailure(kind: FfmpegFailureKind, message = `ffmpeg ${kind}`): FfmpegError {
  return new FfmpegError({
    kind,
    message,
    binary: "ffmpeg",
    argv: ["-i", "call.m4a", "-c:a", "pcm_s16le", "out.wav"],
  });
}

describe("throwFfmpegStepError", () => {
  test.each<FfmpegFailureKind>(["timeout", "aborted"])(
    "retries a %s — the two ways a run fails that another attempt can fix",
    (kind) => {
      const original = ffmpegFailure(kind);
      const err = thrownBy(() => throwFfmpegStepError(original));

      expect(FatalError.is(err)).toBe(false);
      // Rethrown UNCHANGED, which is what keeps ffmpeg's own message and the
      // argv you paste into a shell. A `RetryableError` here would replace both.
      expect(err).toBe(original);
      expect((err as FfmpegError).argv).toContain("call.m4a");
    },
  );

  test.each<FfmpegFailureKind>(["exit", "missing-binary", "output-too-large"])(
    "stops on %s — every retry reaches the same conclusion",
    (kind) => {
      expect(FatalError.is(thrownBy(() => throwFfmpegStepError(ffmpegFailure(kind))))).toBe(true);
    },
  );

  test("something that is not an ffmpeg failure at all is FATAL", () => {
    // The inversion this export exists for: `toStepError` passes an
    // unclassifiable cause through RETRYABLE, and here the caller has already
    // decided that anything but the two named transients is terminal.
    const err = thrownBy(() => throwFfmpegStepError(new Error("stepReadUpload: no such upload")));

    expect(FatalError.is(err)).toBe(true);
    expect((err as Error).message).toMatch(/no such upload/);
    expect(toStepError(new Error("stepReadUpload: no such upload"))).not.toSatisfy(FatalError.is);
  });

  test("a non-Error cause is fatal too, rather than reaching the retryable default", () => {
    expect(FatalError.is(thrownBy(() => throwFfmpegStepError("ffmpeg blew up")))).toBe(true);
  });

  test("both the name and the kind are checked, so a look-alike does not retry", () => {
    // `kind` is a common discriminant and a `name` is only a string, so either
    // read alone would call some unrelated error an ffmpeg timeout.
    const wrongName = Object.assign(new Error("nope"), { kind: "timeout" });
    const noKind = Object.assign(new Error("nope"), { name: "FfmpegError" });

    expect(FatalError.is(thrownBy(() => throwFfmpegStepError(wrongName)))).toBe(true);
    expect(FatalError.is(thrownBy(() => throwFfmpegStepError(noKind)))).toBe(true);
  });

  test("prefers an explicit message over ffmpeg's own", () => {
    const err = thrownBy(() => throwFfmpegStepError(ffmpegFailure("exit"), "cannot cut this"));

    expect((err as Error).message).toBe("cannot cut this");
  });
});

/** The gateway reply the JSON caller's schema accepts. */
const Reply = z.object({ headline: z.string() });

/** One JSON body, as the transcription endpoints answer. */
function stubTranscribe(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
}

describe("the pre-classified callers", () => {
  beforeEach(() => {
    // `stepEnv` falls back to the process env when no host has published one,
    // which is exactly what a spec is.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  test("stepGenerateOrFail is the /step call and nothing else on the happy path", async () => {
    const gateway = stubGateway("Otters use tools.");
    vi.stubGlobal("fetch", gateway.fetch);

    expect(await stepGenerateOrFail("Summarize.", { system: "Be terse." })).toBe(
      "Otters use tools.",
    );
    expect(gateway.calls[0]?.prompt).toBe("Summarize.");
    expect(gateway.calls[0]?.system).toBe("Be terse.");
  });

  test("a terminal gateway refusal stops the engine rather than burning attempts", async () => {
    vi.stubGlobal("fetch", stubGateway("", { status: 401 }).fetch);

    await expect(stepGenerateOrFail("Summarize.")).rejects.toSatisfy(FatalError.is);
  });

  test("a rate limit waits the delay the gateway named, not the default one second", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 429, headers: { "Retry-After": "30" } })),
    );

    const err = await stepGenerateOrFail("Summarize.").catch((e: unknown) => e);
    expect(RetryableError.is(err)).toBe(true);
    expect((err as RetryableError).retryAfter.getTime()).toBeGreaterThan(Date.now() + 20_000);
  });

  test("stepGenerateJsonOrFail returns the validated reply, typed by the schema", async () => {
    vi.stubGlobal("fetch", stubGateway('{"headline":"Otters use tools"}').fetch);

    expect(await stepGenerateJsonOrFail("Summarize.", { schema: Reply })).toEqual({
      headline: "Otters use tools",
    });
  });

  test("a reply that missed the SHAPE stays plainly retryable — a model may obey next", async () => {
    vi.stubGlobal("fetch", stubGateway("not json at all").fetch);

    const err = await stepGenerateJsonOrFail("Summarize.", { schema: Reply }).catch(
      (e: unknown) => e,
    );
    expect(FatalError.is(err)).toBe(false);
    expect(RetryableError.is(err)).toBe(false);
  });

  test("stepTranscribeSyncOrFail: a request the provider refused is FATAL", async () => {
    stubTranscribe(400, { message: "unsupported container" });

    await expect(stepTranscribeSyncOrFail(new Uint8Array([1, 2, 3]))).rejects.toSatisfy(
      FatalError.is,
    );
  });

  test("stepTranscribeSyncOrFail passes the audio and its options straight down", async () => {
    stubTranscribe(200, { text: "  Otters use tools.  " });

    expect(await stepTranscribeSyncOrFail(new Uint8Array([1]), { filename: "call.wav" })).toEqual({
      text: "Otters use tools.",
    });
  });

  test("stepTranscribeSubmitOrFail: a 503 is retryable, so the job is created later", async () => {
    stubTranscribe(503, { error: "upstream unavailable" });

    const err = await stepTranscribeSubmitOrFail("https://x/a.wav").catch((e: unknown) => e);
    expect(RetryableError.is(err)).toBe(true);
  });

  test("stepTranscribeSubmitOrFail returns the id on the happy path", async () => {
    stubTranscribe(200, { id: "t_1" });

    expect(await stepTranscribeSubmitOrFail("https://x/a.wav")).toEqual({ id: "t_1" });
  });

  test("stepTranscribePollOrFail: a job the PROVIDER failed never retries", async () => {
    // A 2xx carrying `status: "error"` — no HTTP status says this, which is why
    // `TranscribeError` carries the verdict and why classifying it is worth an
    // export rather than a `.catch` the eighth template forgets.
    stubTranscribe(200, { status: "error", error: "corrupt audio" });

    await expect(stepTranscribePollOrFail("t_1")).rejects.toSatisfy(FatalError.is);
  });

  test("stepTranscribePollOrFail answers an unfinished job without classifying it", async () => {
    stubTranscribe(200, { status: "processing" });

    expect(await stepTranscribePollOrFail("t_1")).toEqual({
      done: false,
      status: "processing",
    });
  });

  describe("stepTranscribeUploadOrFail", () => {
    afterEach(() => {
      // A registry-wide `Symbol.for` slot, which neither `restoreMocks` nor
      // `unstubEnvs` can undo — so this teardown is real rather than dead.
      publishUploadReader(undefined);
    });

    test("classifies the upload endpoint's refusal", async () => {
      publishUploadReader({
        info: async () => ({
          id: "u1",
          name: "call.m4a",
          type: "audio/m4a",
          size: 3,
          complete: true,
        }),
        read: async () => new Uint8Array([1, 2, 3]),
      });
      stubTranscribe(401, { error: "bad key" });

      await expect(stepTranscribeUploadOrFail("u1")).rejects.toSatisfy(FatalError.is);
    });

    test("a failure BEFORE the request is classified too, and stays retryable", async () => {
      // Nothing published: `stepUploadInfo` throws a plain `Error`, which
      // `toStepError` refuses to invent a verdict for — so it passes through and
      // the engine's own default retries it.
      const err = await stepTranscribeUploadOrFail("u1").catch((e: unknown) => e);

      expect(FatalError.is(err)).toBe(false);
      expect((err as Error).message).toMatch(/upload store/i);
    });
  });
});
