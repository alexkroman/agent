// Copyright 2026 the AAI authors. MIT license.
/**
 * Guest→client `client/send` relay, split out of sandbox.ts for file-size
 * reasons — it is self-contained: no sandbox state beyond the sink map.
 */

import { MAX_CLIENT_EVENT_NAME_LENGTH, MAX_CLIENT_EVENT_PAYLOAD_BYTES } from "@alexkroman1/aai";
import type { ClientSink } from "@alexkroman1/aai/protocol";

/**
 * Handler for guest→client `client/send` notifications: validates the
 * envelope, enforces the payload byte cap, and relays to the session's sink.
 *
 * The payload cap is measured in UTF-8 bytes (`Buffer.byteLength`), matching
 * what actually goes over the WebSocket — `.length` counts UTF-16 code units
 * and undercounts multibyte text. The serialized string exists only for that
 * size check: `ClientSink.event` takes the event object and owns the final
 * envelope serialization (there is no pre-serialized variant of the API), so
 * this is the single stringify on the aai-server side and `data` passes
 * through untouched. The sink lookup runs first so events for unknown or
 * closed sessions never pay the serialization at all.
 *
 * Exported for unit tests.
 */
export function createClientSendHandler(sessionSinks: Map<string, ClientSink>) {
  return (raw: unknown): void => {
    const params = raw as { sessionId: string; event: string; data: unknown };
    if (typeof params.sessionId !== "string" || typeof params.event !== "string") return;
    if (params.event.length > MAX_CLIENT_EVENT_NAME_LENGTH) return;
    const sink = sessionSinks.get(params.sessionId);
    if (!sink?.open) return;
    // `data` may be undefined (event sent with no payload) — JSON.stringify
    // returns undefined for it, so guard before measuring.
    const serializedData = JSON.stringify(params.data ?? null);
    if (Buffer.byteLength(serializedData) > MAX_CLIENT_EVENT_PAYLOAD_BYTES) return;
    sink.event({ type: "custom_event", event: params.event, data: params.data });
  };
}
