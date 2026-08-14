// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:step-errors` epoch 1.
 *
 * The three shapes a step body reaches for when it has to tell the Workflow
 * DevKit whether a failure is worth another attempt: an HTTP response it just
 * got, a rejected model call it is catching, and a failure it has DECIDED is
 * terminal on grounds no status code carries.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { throwFatalStepError, throwStepError, toStepError } from "../../../sdk/step-errors.ts";
import { requireStepEnv, stepGenerate } from "../../../sdk/utils.ts";

/** An HTTP failure, classified from the response itself. */
export async function fetchOrder(id: string): Promise<unknown> {
  "use step";

  const response = await fetch(`https://api.example.com/orders/${id}`);
  // Transient (408/429/5xx) becomes a `RetryableError` carrying the far side's
  // own `Retry-After`; anything else becomes a `FatalError`.
  if (!response.ok) throw toStepError(response, `Order ${id}: HTTP ${response.status}`);
  return await response.json();
}

/** A rejected model call, classified in a `.catch()`. */
export async function summarize(text: string): Promise<string> {
  "use step";

  return await stepGenerate(text, { system: "Summarize in two sentences." }).catch(throwStepError);
}

/** A failure the step has decided is terminal — three more attempts find the same gap. */
export function apiKey(): string {
  try {
    return requireStepEnv("ASSEMBLYAI_API_KEY");
  } catch (err: unknown) {
    return throwFatalStepError(err);
  }
}

/** The same, with the step's own wording in place of the cause's. */
export function apiKeyNamed(): string {
  try {
    return requireStepEnv("ASSEMBLYAI_API_KEY");
  } catch (err: unknown) {
    return throwFatalStepError(err, "This desk needs ASSEMBLYAI_API_KEY to transcribe.");
  }
}

/** The classifier used for its RETURN, where a caller builds the error first. */
export function classify(response: Response, message: string): Error {
  return toStepError(response, message);
}
