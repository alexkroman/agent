// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:utils` epoch 12.
 *
 * Epoch 12 is what is LEFT of `/utils` once it was split by audience: the
 * zero-dependency helpers written inside a TOOL body. Fifteen exports, all with
 * the same reader.
 *
 * The step surface (`stepFetch`, `stepGenerate`, `report`, `mapConcurrent`, the
 * upload and transcription round trips, …) is `@alexkroman1/aai/step` — see
 * `../step/v1.ts`. The platform contracts (the slug shape, the `aai login`
 * confirmation code) and the framework's own wire helpers are on
 * `@alexkroman1/aai/internal`, which is not a public API at all. The old
 * membership rule was a BUILD property — zod-free, so the CLI could import it
 * on every invocation — which is true, still enforced, and not something anyone
 * imports BY.
 *
 * `toolFailure` and `isToolFailure` are not here either, and that is a contract
 * boundary rather than a move: they belong to the `tool` capability, because
 * the failure a tool RETURNS is part of what writing a tool is. They are still
 * on this subpath and still on the root.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import {
  createKeyedLock,
  errorDetail,
  errorMessage,
  isRecord,
  omitUndefined,
  pushCapped,
  safeJsonParse,
  withLock,
} from "../../../sdk/utils.ts";

/** An append-only list an agent keeps, held to a cap in place. */
export function note(log: string[], line: string): string[] {
  return pushCapped(log, line, 50);
}

/** Reading a field off a body nobody has validated. */
export function readState(text: string): string | undefined {
  const body = safeJsonParse(text);
  if (!isRecord(body)) return undefined;
  return typeof body.state === "string" ? body.state : undefined;
}

/** Building the optional half of an object under `exactOptionalPropertyTypes`. */
export function describe(name?: string, note?: string): Record<string, string> {
  return { kind: "order", ...omitUndefined({ name, note }) };
}

/** Serializing work per key, which the LLM loop's concurrency makes necessary. */
const lock = createKeyedLock();

export async function chargeOnce(orderId: string, charge: () => Promise<string>): Promise<string> {
  try {
    return await withLock(lock, orderId, charge);
  } catch (err: unknown) {
    return `${errorMessage(err)} (${errorDetail(err).length} chars of detail)`;
  }
}
