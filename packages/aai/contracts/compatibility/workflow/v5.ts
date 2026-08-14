// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `workflow` epoch 5.
 *
 * Epoch 5 adds `WorkflowDef.uploads` (and its twin on `WorkflowSummary`), which
 * is what lets a workflow take a FILE at all: a run's input is journaled and
 * replayed, so bytes travel to `POST /workflows/uploads` and the input carries
 * the id. Everything epochs 1 through 4 could express still compiles — see
 * `./v1.ts` through `./v4.ts`, retained for that reason — so this file
 * demonstrates only what is new.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { type WorkflowSummary, workflow } from "../../../index.ts";

/**
 * The declaration a file-taking workflow makes.
 *
 * The property itself is an ordinary `z.string()`, because an upload id is what
 * the run really receives; `uploads` is what turns it into a file picker on the
 * page and a stored file before the run starts.
 */
export const transcribe = workflow({
  description: "Transcribe an uploaded recording.",
  input: z.object({
    recording: z.string().describe("A linear-PCM WAV recording"),
    languageCode: z.string().default("en"),
  }),
  uploads: ["recording"],
  async run(input) {
    await Promise.resolve();
    return { recording: input.recording, languageCode: input.languageCode };
  },
});

/** The listing half a page reads, with the same declaration on it. */
export const summary: WorkflowSummary = {
  name: "transcribe",
  // Spread rather than assigned: both are plain optionals, so a
  // present-and-`undefined` value is an error under `exactOptionalPropertyTypes`
  // — which is what a listing built from a declaration has to cope with.
  ...(transcribe.description === undefined ? {} : { description: transcribe.description }),
  ...(transcribe.uploads === undefined ? {} : { uploads: transcribe.uploads }),
};
