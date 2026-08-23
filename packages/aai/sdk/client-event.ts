// Copyright 2026 the AAI authors. MIT license.
/**
 * The one decision `ctx.send` makes: does this event reach the client, and if
 * not, why not.
 *
 * It lives here, in the SDK, rather than in the runtime that enforces it,
 * because two places have to agree about it and only one of them is a
 * transport. The runtime turns a send into a client frame; `createToolContext`
 * (`sdk/_testing-context.ts`) records what a tool sent so a spec can assert on
 * it — and a double that records what the runtime DROPS is a spec passing on a
 * path production never takes. That happened: a 70 KB payload landed in
 * `ctx.sent` and never on the wire, with the assertion green.
 *
 * The caps themselves stay in `constants.ts` beside the protocol schema they
 * mirror; this is only the rule that reads them.
 */

import { MAX_CLIENT_EVENT_NAME_LENGTH, MAX_CLIENT_EVENT_PAYLOAD_BYTES } from "./constants.ts";

/**
 * Why a `ctx.send` never reached the client — one per drop the runtime makes,
 * so a caller can log the reason rather than the fact.
 *
 * @internal
 */
export type ClientEventDrop =
  /** The event NAME is longer than the protocol schema accepts. */
  | { reason: "name-too-long"; detail: string }
  /** `JSON.stringify` threw — a cycle, a `BigInt`. */
  | { reason: "unserializable"; detail: string }
  /** `JSON.stringify` returned nothing — a function, a bare `undefined` symbol. */
  | { reason: "no-json-form"; detail: string }
  /** Serialized larger than the wire cap. */
  | { reason: "too-large"; detail: string };

/**
 * The event's JSON, or the reason it is not being sent.
 *
 * @internal
 */
export type ClientEventDecision = { json: string } | { drop: ClientEventDrop };

/**
 * Decide what becomes of one `ctx.send(event, data)`.
 *
 * Serializes as part of deciding, because two of the four rejections are
 * findings OF the serialization and the fifth outcome — "it is fine" — needs
 * the string anyway. A caller that drops must not re-stringify: `JSON.stringify`
 * on a getter-bearing object is not guaranteed to answer twice the same.
 *
 * @internal
 */
export function decideClientEvent(event: string, data: unknown): ClientEventDecision {
  if (event.length > MAX_CLIENT_EVENT_NAME_LENGTH) {
    return {
      drop: {
        reason: "name-too-long",
        detail: `${event.length} characters, over the ${MAX_CLIENT_EVENT_NAME_LENGTH}-character cap`,
      },
    };
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(data ?? null);
  } catch (err: unknown) {
    return {
      drop: {
        reason: "unserializable",
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }
  if (json === undefined) {
    // `JSON.stringify(() => {})` — no throw, no output. Nothing to put on the
    // wire, and emitting would produce an event the protocol schema rejects
    // further down.
    return { drop: { reason: "no-json-form", detail: `payload is a ${typeof data}` } };
  }
  const bytes = utf8ByteLength(json);
  if (bytes > MAX_CLIENT_EVENT_PAYLOAD_BYTES) {
    return {
      drop: {
        reason: "too-large",
        detail: `${bytes} bytes of JSON, over the ${MAX_CLIENT_EVENT_PAYLOAD_BYTES}-byte cap`,
      },
    };
  }
  return { json };
}

/**
 * One sentence naming what was dropped and why, for a log or a test-time warning.
 *
 * @internal
 */
export function clientEventDropMessage(event: string, drop: ClientEventDrop): string {
  const named = event.length > 64 ? `${event.slice(0, 64)}…` : event;
  return `ctx.send("${named}") was not sent: ${drop.reason} (${drop.detail})`;
}

/**
 * UTF-8 length without `Buffer`, which the browser half of this package cannot
 * have. `TextEncoder` is what the wire measurement has to agree with anyway.
 */
function utf8ByteLength(json: string): number {
  return new TextEncoder().encode(json).byteLength;
}
