// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import {
  TRANSCRIBE_TIMEOUT_MS,
  TranscribeError,
  transcribeFailure,
  transcribeKey,
  transcribeRefusal,
  transcribeSignal,
} from "./_transcribe-shared.ts";
import { ASSEMBLYAI_STT_API_KEY_ENV } from "./providers/stt/assemblyai.ts";

describe("transcribeFailure", () => {
  test("names the call, the status and the provider's own detail", async () => {
    const err = await transcribeFailure(
      Response.json({ error: "audio too short" }, { status: 400 }),
      "transcribe submit",
    );
    expect(err).toBeInstanceOf(TranscribeError);
    expect(err.message).toBe("transcribe submit failed: HTTP 400 — audio too short");
    expect(err).toMatchObject({ status: 400, retryable: false, retryAfter: undefined });
  });

  test("reads `message` or `detail` when there is no `error`", async () => {
    const fromDetail = await transcribeFailure(
      Response.json({ detail: "nope" }, { status: 422 }),
      "x",
    );
    expect(fromDetail.message).toBe("x failed: HTTP 422 — nope");
  });

  test("a transient status is retryable, carrying the delay the server named", async () => {
    const err = await transcribeFailure(
      new Response("not json", { status: 429, headers: { "Retry-After": "30" } }),
      "transcribe poll",
    );
    // A body that is not JSON costs the detail, not the verdict.
    expect(err.message).toBe("transcribe poll failed: HTTP 429");
    expect(err.retryable).toBe(true);
    expect(err.retryAfter?.getTime()).toBeGreaterThan(Date.now() + 20_000);
  });
});

describe("transcribeRefusal", () => {
  test("is terminal, with no status — a provider verdict rather than an HTTP one", () => {
    expect(transcribeRefusal("the job failed")).toMatchObject({
      name: "TranscribeError",
      message: "the job failed",
      status: undefined,
      retryable: false,
    });
  });
});

describe("transcribeKey", () => {
  test("reads the AssemblyAI key by default, and a named variable when one is given", () => {
    vi.stubEnv(ASSEMBLYAI_STT_API_KEY_ENV, "k_default");
    vi.stubEnv("MY_STT_KEY", "k_named");
    expect(transcribeKey({})).toBe("k_default");
    expect(transcribeKey({ apiKeyEnv: "MY_STT_KEY" })).toBe("k_named");
  });

  test("fails by name when the key is not set", () => {
    vi.stubEnv("MY_STT_KEY", undefined);
    expect(() => transcribeKey({ apiKeyEnv: "MY_STT_KEY" })).toThrow(/MY_STT_KEY/);
  });
});

describe("transcribeSignal", () => {
  test("defaults the deadline to TRANSCRIBE_TIMEOUT_MS, and honours a caller's own", () => {
    // `AbortSignal.timeout` runs on Node's internal timers, which fake timers do
    // not drive, so the budget is read off the call rather than waited out.
    const timeout = vi.spyOn(AbortSignal, "timeout");
    transcribeSignal({});
    transcribeSignal({ timeoutMs: 5 });
    expect(timeout.mock.calls).toEqual([[TRANSCRIBE_TIMEOUT_MS], [5]]);
  });

  test("aborts when the caller's own signal does", () => {
    const controller = new AbortController();
    const signal = transcribeSignal({ signal: controller.signal });
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});
