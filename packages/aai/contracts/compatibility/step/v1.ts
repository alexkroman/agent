// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:step` epoch 1.
 *
 * The vocabulary a `"use step"` body is written against, from one import path.
 * Epoch 1 is the split itself: these names were on `@alexkroman1/aai/utils`,
 * whose membership rule was a BUILD property ("zod-free, so the CLI can import
 * it on every invocation") rather than an audience. Seventy-nine exports served
 * three unrelated readers, so the import line said nothing about which layer
 * you were in and the step vocabulary had no reference page of its own.
 *
 * The zero-zod budget is unchanged and still load-bearing for a different
 * reason: a `workflows/*.ts` module is bundled separately, so the root barrel's
 * graph would ride into the step bundle.
 *
 * `toStepError` and friends stay on `@alexkroman1/aai/step-errors` — that is
 * the one authoring module allowed to import the DevKit's `workflow` package —
 * and the DevKit's own directives and durable `sleep` are imported from
 * `workflow` directly.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import {
  encodeWav,
  mapConcurrent,
  report,
  requireStepEnv,
  stepFetch,
  stepGenerate,
  stepSpeak,
} from "../../../sdk/step-barrel.ts";

/** One `fetch` against a third-party API, on HTTP/1.1 and the agent's own key. */
export async function fetchTranscriptText(id: string): Promise<string> {
  "use step";
  const key = requireStepEnv("VENDOR_API_KEY");
  const res = await stepFetch(`https://example.invalid/transcripts/${id}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  return await res.text();
}

/** A bounded fan-out: a window over a cursor, so a slow item costs only itself. */
export async function summarizeEach(chunks: readonly string[]): Promise<string[]> {
  "use step";
  return await mapConcurrent(chunks, 4, (chunk) => stepGenerate(`Summarize:\n${chunk}`));
}

/** The audio round trip out, and the narration a page renders. */
export async function speakSummary(text: string): Promise<Uint8Array> {
  "use step";
  await report("synthesizing");
  const spoken = await stepSpeak(text, { voice: "jane" });
  return encodeWav(spoken.pcm, { sampleRate: spoken.sampleRate, channels: 1 });
}
