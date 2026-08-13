// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the transcription desk's declaration and the pure half of its
 * workflow body.
 *
 * **The body itself is not callable here, and that is a property of what this
 * template demonstrates rather than a gap in the spec.** `transcribeFlow` opens
 * a webhook, and `createWebhook()` throws `can only be called inside a workflow
 * function` outside a run — the DevKit's own stub, not ours. `research-desk`'s
 * spec has the same limitation for the same reason and says so; the version of
 * this file that predated the webhook could call the body only because every
 * `"use step"` in it was an ordinary function with no waitpoint between them.
 *
 * So what is asserted here is what can be asserted WITHOUT a world: the
 * declaration a run is validated against — which is also what the page renders
 * its form from, so it is two contracts in one — the segmentation the fan-out's
 * width comes from, and the STEPS, which are ordinary async functions until the
 * transform runs and are exported for exactly that reason. The webhook round
 * trip, the replay, and the step correlation are exercised end to end by
 * `aai-cli`'s `dev-workflow.integration.test.ts`, which builds a project and
 * runs one.
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import agentDef, { transcribe } from "./agent.ts";
import {
  file,
  postProcess,
  splitTranscript,
  submitTranscriptionJob,
} from "./workflows/transcribe.ts";

/** A well-formed submission, exactly as the page's `<Form>` collects it. */
function submission(over: Record<string, unknown> = {}) {
  return {
    upload: { name: "standup.m4a", type: "audio/mp4", size: 812_000 },
    requestedBy: "alex",
    redact: true,
    ...over,
  };
}

describe("the agent declares its workflow and nothing else", () => {
  test("under the name the REST route resolves it by", () => {
    expect(Object.keys(agentDef.workflows ?? {})).toEqual(["transcribe"]);
    expect(agentDef.workflows?.transcribe).toBe(transcribe);
  });

  test("with no tools, because the interface is the page and the API", () => {
    // The point of the template: a workflow app needs no conversation. A tool
    // reappearing here would mean the voice path had crept back in.
    expect(Object.keys(agentDef.tools ?? {})).toEqual([]);
  });
});

describe("the input schema", () => {
  test("accepts what the page's form collects, with no mapping in between", async () => {
    // The `<FileField>` contributes `{ name, type, size, lastModified }` under
    // its own name and `<WorkflowFields>` contributes the two scalars, so the
    // collected object IS the run input — that equality is the claim.
    const result = await transcribe.input?.["~standard"].validate({
      ...submission(),
      upload: { name: "standup.m4a", type: "audio/mp4", size: 812_000, lastModified: 1 },
    });
    expect(result?.issues).toBeUndefined();
  });

  test("defaults `redact` off, so the checkbox's absence is not an error", async () => {
    const result = await transcribe.input?.["~standard"].validate({
      upload: { name: "a.m4a", type: "audio/mp4", size: 10 },
      requestedBy: "alex",
    });
    // Re-tested rather than trusted: a Standard Schema result is a union, so
    // this is what makes `value` reachable without a cast.
    expect(result?.issues).toBeUndefined();
    if (result?.issues) expect.fail("expected the submission to validate");
    expect(result?.value).toMatchObject({ redact: false });
  });

  test("rejects an empty recording at the call site rather than in a step", async () => {
    // A zero-byte upload fails HERE — a 400 on the POST, with the run never
    // created — instead of becoming a failed run discovered minutes later.
    const result = await transcribe.input?.["~standard"].validate(
      submission({ upload: { name: "empty.m4a", type: "audio/mp4", size: 0 } }),
    );
    expect(result?.issues).toBeDefined();
  });

  test("rejects a submission with no file", async () => {
    const { upload: _dropped, ...withoutFile } = submission();
    const result = await transcribe.input?.["~standard"].validate(withoutFile);
    expect(result?.issues).toBeDefined();
  });

  test("describes the two scalar fields, which is what labels them on the page", async () => {
    // `<WorkflowFields>` renders a control per scalar property and uses each
    // `.describe()` as its hint, so a missing description is a bare field.
    // Narrowed rather than cast: `input` is a Standard Schema, and only a
    // `ZodObject` has the `shape` this reads.
    const schema = transcribe.input;
    if (!(schema instanceof z.ZodObject)) expect.fail("expected a zod object schema");
    expect(schema.shape.requestedBy?.description).toBeTruthy();
    expect(schema.shape.redact?.description).toBeTruthy();
  });
});

describe("splitTranscript decides the fan-out's width", () => {
  test("keeps every word, in order", () => {
    const words = Array.from({ length: 130 }, (_unused, index) => `w${index}`);
    const segments = splitTranscript(words.join(" "));
    expect(segments.join(" ").split(" ")).toEqual(words);
  });

  test("does not drop a partial final segment", () => {
    // 130 words at 40 per segment is three full segments and one of ten — the
    // case a `for` loop with the wrong bound silently truncates.
    const segments = splitTranscript(
      Array.from({ length: 130 }, (_unused, index) => `w${index}`).join(" "),
    );
    expect(segments).toHaveLength(4);
    expect(segments.at(-1)?.split(" ")).toHaveLength(10);
  });

  test("reports no segments for an empty transcript rather than one empty segment", () => {
    // A single empty segment would fan out one step that transcribes nothing.
    expect(splitTranscript("   ")).toEqual([]);
  });
});

describe("submitTranscriptionJob", () => {
  /** A `fetch` that records the simulated provider's callback. */
  function stubFetch(ok = true) {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(null, { status: ok ? 202 : 500 });
      }),
    );
    return calls;
  }

  test("delivers the callback to the URL it was handed", async () => {
    // The stub provider's whole trick: it calls the webhook back itself, so the
    // template runs end to end with no account and no stored audio.
    const calls = stubFetch();
    const jobId = await submitTranscriptionJob(
      { name: "standup.m4a", type: "audio/mp4", size: 812_000 },
      "http://127.0.0.1:9/.well-known/workflow/v1/webhook/tok",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/webhook/tok");
    expect(calls[0]?.body).toMatchObject({ jobId });
  });

  test("mints the same job id for the same upload, so a retry is not a new job", async () => {
    stubFetch();
    const upload = { name: "standup.m4a", type: "audio/mp4", size: 812_000 };
    const first = await submitTranscriptionJob(upload, "http://x/cb");
    const second = await submitTranscriptionJob(upload, "http://x/cb");
    // A step may be retried; an id that changed per attempt would make the
    // run's own delivery check fail on the second one.
    expect(first).toBe(second);
  });

  test("fails FATALLY on an empty upload rather than retrying it three times", async () => {
    stubFetch();
    await expect(
      submitTranscriptionJob({ name: "empty.m4a", type: "audio/mp4", size: 0 }, "http://x/cb"),
    ).rejects.toThrow(/nothing to transcribe/);
  });

  test("throws plainly when the delivery fails, which is what a retry wants", async () => {
    stubFetch(false);
    await expect(
      submitTranscriptionJob({ name: "a.m4a", type: "audio/mp4", size: 10 }, "http://x/cb"),
    ).rejects.toThrow(/Callback delivery failed/);
  });
});

describe("postProcess", () => {
  const SEGMENT = "call desk@example.com or 555-010-9999 today";

  test("masks the two identifiers a transcript most often leaks", async () => {
    const cleaned = await postProcess(SEGMENT, true);
    expect(cleaned).toBe("call [email] or [phone] today");
  });

  test("leaves the segment alone when redaction was not asked for", async () => {
    expect(await postProcess(SEGMENT, false)).toBe(SEGMENT);
  });
});

describe("file", () => {
  test("reports when it filed, which is the one thing the body cannot read itself", async () => {
    // A clock read in the BODY would differ on every replay; a step's result is
    // journaled, so this timestamp is stable once it has run.
    expect(Date.parse(await file("alex", "standup.m4a"))).not.toBeNaN();
  });
});
