// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for `transcribeUploadDurably`, over the `/testing` recorder.
 *
 * The subject is the COMPOSITION: which steps it journals and under which
 * names, that each one's failure leaves classified, and what spending the
 * budget costs. The three calls inside the steps have their own specs
 * (`step-transcribe.test.ts`), and the provider is `stubTranscribe`, which
 * refuses by HTTP status so the SDK's own classifier is the one under test.
 */

import { describe, expect, test, vi } from "vitest";
import { TranscribeError } from "./_transcribe-shared.ts";
import { FatalError, RetryableError } from "./step-error-classes.ts";
import {
  TRANSCRIBE_DURABLY_STEPS,
  TRANSCRIBE_POLL_EVERY_MS,
  TRANSCRIBE_POLL_MAX_MS,
  transcribeUploadDurably,
} from "./step-transcribe-durably.ts";
import { installStubTranscribe, installStubUploads } from "./testing-vitest.ts";
import { createWorkflowContext } from "./testing-workflow-ctx.ts";

const { upload, submit, poll } = TRANSCRIBE_DURABLY_STEPS;

/** The key in the env, and a recording named `call.m4a` in the store. */
function arrange(files: Parameters<typeof installStubUploads>[0] = {}): void {
  vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  installStubUploads({
    rec: { bytes: new Uint8Array([1, 2, 3, 4]), name: "call.m4a", type: "audio/m4a" },
    ...files,
  });
}

describe("transcribeUploadDurably", () => {
  test("journals upload, submit and poll under its fixed names, and answers the transcript", async () => {
    arrange();
    const provider = installStubTranscribe({ text: "we ship tuesday", durationSec: 42 });
    const ctx = createWorkflowContext();

    const transcript = await transcribeUploadDurably(ctx, "rec");

    expect(transcript).toEqual({
      id: "stub_transcript_1",
      text: "we ship tuesday",
      durationMs: 42_000,
      source: "call.m4a",
    });
    expect(ctx.steps.map((step) => step.name)).toEqual([upload, submit, poll]);
    expect(ctx.slept).toEqual([]);
    expect(provider.calls.map((call) => call.leg)).toEqual(["upload", "submit", "poll"]);
  });

  test("`source` falls back to the id when the uploader named no file", async () => {
    arrange({ bare: new Uint8Array([9]) });
    installStubTranscribe();

    const transcript = await transcribeUploadDurably(createWorkflowContext(), "bare");

    expect(transcript.source).toBe("bare");
  });

  test("polls as `ctx.poll` does: a check per round, a durable sleep between", async () => {
    arrange();
    installStubTranscribe({ pendingPolls: 2 });
    const ctx = createWorkflowContext();

    await transcribeUploadDurably(ctx, "rec", { everyMs: 5000 });

    expect(ctx.steps.map((step) => step.name)).toEqual([upload, submit, poll, poll, poll]);
    // Sleeps are RECORDED by the recorder, never taken: the schedule is the
    // assertion, under the poll's own name so a wake can find it.
    expect(ctx.slept.map((sleep) => [sleep.label, sleep.until])).toEqual([
      [poll, 5000],
      [poll, 5000],
    ]);
  });

  test("defaults to a 10-second interval and an hour's budget", async () => {
    arrange();
    installStubTranscribe({ pendingPolls: 1 });
    const ctx = createWorkflowContext();

    await transcribeUploadDurably(ctx, "rec");

    expect(ctx.slept).toEqual([
      { label: poll, until: TRANSCRIBE_POLL_EVERY_MS, correlationId: undefined },
    ]);
    expect(TRANSCRIBE_POLL_EVERY_MS).toBe(10_000);
    expect(TRANSCRIBE_POLL_MAX_MS).toBe(3_600_000);
  });

  test("spending the budget is a refusal that names the job and where to read it", async () => {
    arrange();
    installStubTranscribe({ pendingPolls: 10 });
    const ctx = createWorkflowContext();

    // `maxMs / everyMs` = 2 sleeps, so three checks and then the refusal.
    const err = await transcribeUploadDurably(ctx, "rec", { everyMs: 1000, maxMs: 2000 }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TranscribeError);
    // NOT retryable: the job is still running on the provider's side and a
    // second attempt would upload the recording again and start a second one.
    expect(err).toMatchObject({ retryable: false });
    expect((err as Error).message).toContain(
      "It is not lost — read it with GET /v2/transcript/stub_transcript_1",
    );
    expect((err as Error).message).toContain("call.m4a");
    expect((err as Error).message).toContain("3 checks");
    expect(ctx.steps.filter((step) => step.name === poll)).toHaveLength(3);
  });

  test("passes `params` and `models` to the submit, verbatim", async () => {
    arrange();
    const provider = installStubTranscribe();

    await transcribeUploadDurably(createWorkflowContext(), "rec", {
      params: { speaker_labels: true, language_code: "es" },
      models: ["custom"],
    });

    const sent = provider.calls.find((call) => call.leg === "submit");
    expect(JSON.parse(String(sent?.body))).toMatchObject({
      speaker_labels: true,
      language_code: "es",
      speech_models: ["custom"],
    });
  });

  test("hands `maxAttempts` to the upload step ALONE — the one whose cost is the file", async () => {
    arrange();
    installStubTranscribe();
    const ctx = createWorkflowContext();

    await transcribeUploadDurably(ctx, "rec", { maxAttempts: 5 });

    expect(ctx.steps.map((step) => [step.name, step.maxAttempts])).toEqual([
      [upload, 5],
      [submit, undefined],
      [poll, undefined],
    ]);
  });

  test("reads the credential from `apiKeyEnv` on every leg", async () => {
    arrange();
    vi.stubEnv("OTHER_KEY", "sk-other");
    const provider = installStubTranscribe();

    await transcribeUploadDurably(createWorkflowContext(), "rec", { apiKeyEnv: "OTHER_KEY" });

    expect(provider.calls.map((call) => call.headers.Authorization)).toEqual([
      "sk-other",
      "sk-other",
      "sk-other",
    ]);
  });

  describe("every step's failure leaves CLASSIFIED, so the engine spends attempts where they help", () => {
    test("a 401 on the upload is FATAL on the first attempt", async () => {
      arrange();
      installStubTranscribe({ failure: { leg: "upload", status: 401 } });

      await expect(transcribeUploadDurably(createWorkflowContext(), "rec")).rejects.toSatisfy(
        FatalError.is,
      );
    });

    test("a 429 on the submit is RETRYABLE, carrying the delay the service named", async () => {
      arrange();
      installStubTranscribe({ failure: { leg: "submit", status: 429, retryAfterSeconds: 30 } });

      const err = await transcribeUploadDurably(createWorkflowContext(), "rec").catch(
        (e: unknown) => e,
      );

      expect(err).toSatisfy(RetryableError.is);
      expect((err as RetryableError).retryAfter.getTime()).toBeGreaterThan(Date.now() + 20_000);
    });

    test("a job the PROVIDER failed is fatal rather than polled until the budget runs out", async () => {
      arrange();
      installStubTranscribe({ jobError: "corrupt audio" });
      const ctx = createWorkflowContext();

      const err = await transcribeUploadDurably(ctx, "rec").catch((e: unknown) => e);

      expect(err).toSatisfy(FatalError.is);
      expect((err as Error).message).toContain("corrupt audio");
      expect(ctx.steps.filter((step) => step.name === poll)).toHaveLength(1);
    });

    test("an upload still arriving is refused before the upload leg, fatally", async () => {
      arrange({ partial: { bytes: new Uint8Array([1]), complete: false } });
      const provider = installStubTranscribe();

      await expect(transcribeUploadDurably(createWorkflowContext(), "partial")).rejects.toSatisfy(
        FatalError.is,
      );
      expect(provider.calls).toEqual([]);
    });
  });
});
