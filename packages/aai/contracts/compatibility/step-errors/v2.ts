// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:step-errors` epoch 2.
 *
 * Epoch 1's three shapes, plus the one this epoch adds: `stepFetchOk`, which is
 * the request-and-classify pair epoch 1 spelled out by hand — compare
 * {@link fetchOrder} here with the version in `./v1.ts`, which is retained and
 * still compiles.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import {
  stepFetchOk,
  throwFatalStepError,
  throwStepError,
  toStepError,
} from "../../../sdk/step-errors.ts";
import { requireStepEnv, stepGenerate } from "../../../sdk/utils.ts";

/** An HTTP call whose failure is simply a failure — one call, no `ok` check. */
export async function fetchOrder(id: string): Promise<unknown> {
  "use step";

  const response = await stepFetchOk(`https://api.example.com/orders/${id}`);
  return await response.json();
}

/** The same with a method, headers and a body, which pass straight through. */
export async function placeOrder(sku: string): Promise<unknown> {
  "use step";

  const response = await stepFetchOk("https://api.example.com/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku }),
    signal: AbortSignal.timeout(30_000),
  });
  return await response.json();
}

/** Still `toStepError` where a status is not simply a failure — 404 means gone. */
export async function deleteOrder(id: string): Promise<void> {
  "use step";

  const response = await fetch(`https://api.example.com/orders/${id}`, { method: "DELETE" });
  if (response.status === 404) return;
  if (!response.ok) throw toStepError(response, `Order ${id}: HTTP ${response.status}`);
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

/** The classifier used for its RETURN, where a caller builds the error first. */
export function classify(response: Response, message: string): Error {
  return toStepError(response, message);
}
