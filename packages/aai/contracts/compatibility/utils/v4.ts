// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `utils` epoch 4.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative. Epoch 4 adds the surface a `"use step"` body reaches for —
 * `stepEnv`/`requireStepEnv` and `stepGenerate` — to epoch 3's and takes nothing
 * away, which is why `../utils/v3.ts` (and the epochs beneath it) are retained
 * rather than dropped; this file only has to demonstrate what is new.
 *
 * The `"use step"` directives are inert here, because nothing compiles this
 * through the Workflow DevKit's builder. That is the point: what is frozen is
 * the way an author WRITES a step, and the only thing this has to keep doing is
 * compile.
 */

import { requireStepEnv, StepGenerateError, stepEnv, stepGenerate } from "../../../sdk/utils.ts";

/**
 * The shape a step that calls a provider directly writes: no `ToolContext`, so
 * the credential comes from the agent env by name and fails by name.
 */
export async function transcribe(recordingUrl: string): Promise<string> {
  "use step";

  const apiKey = requireStepEnv("ASSEMBLYAI_API_KEY");
  const response = await fetch("https://sync.assemblyai.com/transcribe", {
    method: "POST",
    headers: { Authorization: apiKey, "X-AAI-Model": "universal-3-5-pro" },
    body: JSON.stringify({ audio_url: recordingUrl }),
  });
  return ((await response.json()) as { text: string }).text;
}

/** The optional half: a key an author supplies a default for. */
export function region(): string {
  return stepEnv("ASSEMBLYAI_REGION") ?? "global";
}

/**
 * The model call, with the retry decision the error is shaped for.
 *
 * `FatalError` is not imported here — this file compiles under the SDK's own
 * tsconfig, which has no DevKit around it — so the classification is what an
 * author reads and the branch stands in for the throw.
 */
export async function summarize(text: string): Promise<string> {
  "use step";

  try {
    return await stepGenerate(text, { system: "Summarize in two sentences.", maxTokens: 200 });
  } catch (err: unknown) {
    if (err instanceof StepGenerateError && !err.retryable) {
      throw new Error(`giving up rather than retrying: ${err.message}`, { cause: err });
    }
    throw err;
  }
}
