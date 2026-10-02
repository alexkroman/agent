// Copyright 2026 the AAI authors. MIT license.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { FfmpegError, type FfmpegFailureKind } from "../host/ffmpeg.ts";
import { FatalError, RetryableError } from "./step-error-classes.ts";
import { orFail, throwFfmpegStepError, toStepError } from "./step-errors.ts";
import { stepFetch } from "./step-fetch.ts";
import { stepGenerate } from "./step-generate.ts";
import { stepGenerateJson } from "./step-generate-json.ts";
import {
  stepTranscribePoll,
  stepTranscribeSubmit,
  stepTranscribeUpload,
} from "./step-transcribe.ts";
import { stepTranscribeSync } from "./step-transcribe-sync.ts";
import { publishUploadReader } from "./step-uploads.ts";
import { stubGateway } from "./testing-gateway.ts";

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

/**
 * `orFail(stepFetch)` reaches the network through `stepFetch`, whose slot is
 * UNPUBLISHED in a spec — so it falls back to `globalThis.fetch`, which is
 * exactly the seam these cases stub. See `step-fetch.ts`'s module doc.
 */
describe("orFail(stepFetch)", () => {
  const stubFetch = (response: Response) => {
    const fetch = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };

  test("returns the response untouched on 2xx, body unread", async () => {
    stubFetch(new Response("the body", { status: 200 }));

    const response = await orFail(stepFetch)("https://api.test/thing");

    expect(response.status).toBe(200);
    // The success path must not consume the body — the caller chooses.
    expect(response.bodyUsed).toBe(false);
    await expect(response.text()).resolves.toBe("the body");
  });

  test("makes a 4xx FATAL, so the engine stops rather than asking three more times", async () => {
    stubFetch(new Response("nope", { status: 404 }));

    const err = await orFail(stepFetch)("https://api.test/gone").catch((e: unknown) => e);

    expect(stepVerdict(err)).toEqual({ fatal: true, retryable: false });
  });

  test("makes a 5xx RETRYABLE, honouring a Retry-After the server named", async () => {
    // On an exact second, because `Retry-After` has no sub-second resolution —
    // a date carrying milliseconds does not survive `toUTCString()` and the
    // comparison below would be off by one on roughly half of all runs.
    const at = new Date(Math.floor(Date.now() / 1000) * 1000 + 120_000);
    stubFetch(new Response("busy", { status: 503, headers: { "Retry-After": at.toUTCString() } }));

    const err = await orFail(stepFetch)("https://api.test/busy").catch((e: unknown) => e);

    expect(stepVerdict(err)).toMatchObject({ fatal: false, retryable: true });
    expect((err as RetryableError).retryAfter.getTime()).toBe(at.getTime());
  });

  /** The half a hand-written `if (!res.ok)` throws away — see the doc. */
  test("carries the far side's own error text into the message", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: "podcast feed is not public" }), { status: 403 }),
    );

    const err = await orFail(stepFetch)("https://api.test/feed").catch((e: unknown) => e);

    expect((err as Error).message).toBe("podcast feed is not public");
  });

  test("falls back to the request, the status and a body preview", async () => {
    stubFetch(new Response("<html>gateway timeout</html>", { status: 504 }));

    const err = await orFail(stepFetch)("https://api.test/slow", { method: "POST" }).catch(
      (e: unknown) => e,
    );

    // The METHOD and URL, because a run's log holds many of these.
    expect((err as Error).message).toContain("POST https://api.test/slow");
    expect((err as Error).message).toContain("504");
    expect((err as Error).message).toContain("gateway timeout");
  });

  test("labels a request with no explicit method as GET", async () => {
    stubFetch(new Response("", { status: 500 }));

    const err = await orFail(stepFetch)("https://api.test/x").catch((e: unknown) => e);

    expect((err as Error).message).toContain("GET https://api.test/x");
  });

  test("passes method, headers and body straight through to stepFetch", async () => {
    const fetch = stubFetch(new Response("ok", { status: 200 }));

    await orFail(stepFetch)("https://api.test/post", {
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

  test("orFail(stepGenerate) is the /step call and nothing else on the happy path", async () => {
    const gateway = stubGateway("Otters use tools.");
    vi.stubGlobal("fetch", gateway.fetch);

    expect(await orFail(stepGenerate)("Summarize.", { system: "Be terse." })).toBe(
      "Otters use tools.",
    );
    expect(gateway.calls[0]?.prompt).toBe("Summarize.");
    expect(gateway.calls[0]?.system).toBe("Be terse.");
  });

  test("a terminal gateway refusal stops the engine rather than burning attempts", async () => {
    vi.stubGlobal("fetch", stubGateway("", { status: 401 }).fetch);

    await expect(orFail(stepGenerate)("Summarize.")).rejects.toSatisfy(FatalError.is);
  });

  test("a rate limit waits the delay the gateway named, not the default one second", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 429, headers: { "Retry-After": "30" } })),
    );

    const err = await orFail(stepGenerate)("Summarize.").catch((e: unknown) => e);
    expect(RetryableError.is(err)).toBe(true);
    expect((err as RetryableError).retryAfter.getTime()).toBeGreaterThan(Date.now() + 20_000);
  });

  test("orFail(stepGenerateJson) returns the validated reply, typed by the schema", async () => {
    vi.stubGlobal("fetch", stubGateway('{"headline":"Otters use tools"}').fetch);

    expect(await orFail(stepGenerateJson)("Summarize.", { schema: Reply })).toEqual({
      headline: "Otters use tools",
    });
  });

  test("a reply that missed the SHAPE stays plainly retryable — a model may obey next", async () => {
    vi.stubGlobal("fetch", stubGateway("not json at all").fetch);

    const err = await orFail(stepGenerateJson)("Summarize.", { schema: Reply }).catch(
      (e: unknown) => e,
    );
    expect(FatalError.is(err)).toBe(false);
    expect(RetryableError.is(err)).toBe(false);
  });

  test("orFail(stepTranscribeSync): a request the provider refused is FATAL", async () => {
    stubTranscribe(400, { message: "unsupported container" });

    await expect(orFail(stepTranscribeSync)(new Uint8Array([1, 2, 3]))).rejects.toSatisfy(
      FatalError.is,
    );
  });

  test("orFail(stepTranscribeSync) passes the audio and its options straight down", async () => {
    stubTranscribe(200, { text: "  Otters use tools.  " });

    expect(await orFail(stepTranscribeSync)(new Uint8Array([1]), { filename: "call.wav" })).toEqual(
      {
        text: "Otters use tools.",
      },
    );
  });

  test("orFail(stepTranscribeSubmit): a 503 is retryable, so the job is created later", async () => {
    stubTranscribe(503, { error: "upstream unavailable" });

    const err = await orFail(stepTranscribeSubmit)("https://x/a.wav").catch((e: unknown) => e);
    expect(RetryableError.is(err)).toBe(true);
  });

  test("orFail(stepTranscribeSubmit) returns the id on the happy path", async () => {
    stubTranscribe(200, { id: "t_1" });

    expect(await orFail(stepTranscribeSubmit)("https://x/a.wav")).toEqual({ id: "t_1" });
  });

  test("orFail(stepTranscribePoll): a job the PROVIDER failed never retries", async () => {
    // A 2xx carrying `status: "error"` — no HTTP status says this, which is why
    // `TranscribeError` carries the verdict and why classifying it is worth an
    // export rather than a `.catch` the eighth template forgets.
    stubTranscribe(200, { status: "error", error: "corrupt audio" });

    await expect(orFail(stepTranscribePoll)("t_1")).rejects.toSatisfy(FatalError.is);
  });

  test("orFail(stepTranscribePoll) answers an unfinished job without classifying it", async () => {
    stubTranscribe(200, { status: "processing" });

    expect(await orFail(stepTranscribePoll)("t_1")).toEqual({
      done: false,
      status: "processing",
    });
  });

  describe("orFail(stepTranscribeUpload)", () => {
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

      await expect(orFail(stepTranscribeUpload)("u1")).rejects.toSatisfy(FatalError.is);
    });

    test("a failure BEFORE the request is classified too, and stays retryable", async () => {
      // Nothing published: `stepUploadInfo` throws a plain `Error`, which
      // `toStepError` refuses to invent a verdict for — so it passes through and
      // the engine's own default retries it.
      const err = await orFail(stepTranscribeUpload)("u1").catch((e: unknown) => e);

      expect(FatalError.is(err)).toBe(false);
      expect((err as Error).message).toMatch(/upload store/i);
    });
  });
});
