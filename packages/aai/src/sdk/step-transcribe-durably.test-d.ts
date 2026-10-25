// Copyright 2026 the AAI authors. MIT license.
/**
 * `transcribeUploadDurably` takes the body's own `ctx`: the host shape it
 * declares has to stay one a `WorkflowContext` satisfies, or the call site in
 * every body breaks at the parameter.
 */

import { expectTypeOf, test } from "vitest";
import type { Transcript } from "./step-transcribe.ts";
import type {
  DurableTranscript,
  TranscribeDurablyHost,
  transcribeUploadDurably,
} from "./step-transcribe-durably.ts";
import type { WorkflowContextRecorder } from "./testing-workflow-ctx.ts";
import type { WorkflowContext } from "./workflow-ctx.ts";

test("a WorkflowContext — and the /testing recorder — is a TranscribeDurablyHost", () => {
  expectTypeOf<WorkflowContext>().toExtend<TranscribeDurablyHost>();
  expectTypeOf<WorkflowContextRecorder>().toExtend<TranscribeDurablyHost>();
});

test("resolves the transcript plus the recording's display name", () => {
  expectTypeOf<DurableTranscript>().toExtend<Transcript>();
  expectTypeOf<DurableTranscript["source"]>().toEqualTypeOf<string>();
  expectTypeOf<
    Awaited<ReturnType<typeof transcribeUploadDurably>>
  >().toEqualTypeOf<DurableTranscript>();
});
