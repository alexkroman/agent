// Copyright 2026 the AAI authors. MIT license.
/**
 * `stubClientTranscript()` — a client's durable conversation, for a spec of the
 * step that reads it with `stepClientTranscript`.
 *
 * Published into the same slot `createRuntime` fills, so a step under test
 * takes the path production does — including the client-id check, which runs
 * before the slot is read. The sibling of `stubClientInbox`, and shaped like it.
 *
 * @module
 */

import { recordingSlot } from "./_testing-slot.ts";
import {
  type ClientTranscript,
  publishClientTranscriptReader,
  type StepClientTranscriptOptions,
} from "./step-client-transcript.ts";

/** One read, as {@link stubClientTranscript} records it. */
export type StubClientTranscriptCall = { clientId: string; options: StepClientTranscriptOptions };

/** What {@link stubClientTranscript} answers each read with. */
export type StubClientTranscriptAnswer =
  | ClientTranscript
  | ((call: StubClientTranscriptCall) => ClientTranscript);

/** What {@link stubClientTranscript} returns: the call log, and how to put the slot back. */
export type StubClientTranscript = {
  /** Every read, in order. */
  calls: StubClientTranscriptCall[];
  /** Unpublish the reader. Call it in an `afterEach`, like `stubClientInbox`'s. */
  restore(): void;
};

/**
 * Publish a reader that answers every `stepClientTranscript` with `answer` —
 * a fixed transcript, or one computed per call (e.g. honouring the cursor).
 * Omitted, every client has said nothing.
 *
 * @public
 */
export function stubClientTranscript(
  answer: StubClientTranscriptAnswer = { sessions: [] },
): StubClientTranscript {
  return recordingSlot(
    publishClientTranscriptReader,
    (clientId, options): StubClientTranscriptCall => ({ clientId, options }),
    (call) => Promise.resolve(typeof answer === "function" ? answer(call) : answer),
  );
}
