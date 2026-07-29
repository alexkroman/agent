// Copyright 2025 the AAI authors. MIT license.
/**
 * Host-side fetch handler for the sandbox: relays a guest's proxied `fetch`,
 * streaming the response back in chunks via an emit callback.
 *
 * The **policy** — allowlist, body/response caps, timeout, concurrency, SSRF —
 * is not decided here. It lives in the SDK's `host/guest-fetch-policy.ts`,
 * which self-hosted mode (`aai dev`) is also routed through, so tool code
 * cannot behave one way locally and another once deployed. This module owns
 * only the NDJSON relay: what to do with a verdict, not what the verdict is.
 * Resist re-adding a limit here.
 */

import { errorMessage } from "@alexkroman1/aai";
import {
  checkToolFetch,
  performToolFetch,
  TOOL_FETCH_MAX_RESPONSE_BYTES,
} from "@alexkroman1/aai/runtime";

/**
 * 256 KiB per relayed chunk. Each chunk costs a base64 encode, a JSON frame,
 * a pipe write, and a guest-side parse+decode, so bigger chunks cut the
 * per-chunk overhead on large responses; the guest's incremental line
 * scanner handles multi-MB lines linearly, and the 4 MB response cap bounds
 * the worst case.
 */
const CHUNK_SIZE = 256 * 1024;

export type FetchRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null; // base64-encoded
};

export type FetchResponseStart = {
  type: "fetch/response-start";
  id: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
};

export type FetchResponseChunk = {
  type: "fetch/response-chunk";
  id: string;
  data: string; // base64-encoded
};

export type FetchResponseEnd = {
  type: "fetch/response-end";
  id: string;
};

export type FetchResponseError = {
  type: "fetch/response-error";
  id: string;
  message: string;
};

export type FetchResponseMessage =
  | FetchResponseStart
  | FetchResponseChunk
  | FetchResponseEnd
  | FetchResponseError;

type FetchHandlerOptions = {
  allowedHosts: string[];
  fetchFn?: typeof globalThis.fetch;
  skipSsrf?: boolean;
  /**
   * Response cap override. Tests shrink it to assert the streaming cap without
   * moving 4 MiB of bytes; production leaves it at
   * {@link TOOL_FETCH_MAX_RESPONSE_BYTES}. There is deliberately no override
   * for the allowlist, timeout, body cap, or concurrency — those come from the
   * shared policy so the two execution modes cannot diverge.
   */
  maxResponseBytes?: number;
};

type Emit = (msg: FetchResponseMessage) => void;

function emitError(id: string, message: string, emit: Emit): void {
  emit({ type: "fetch/response-error", id, message });
}

function emitChunk(id: string, bytes: Uint8Array, emit: Emit): void {
  // Buffer.from(uint8Array) copies; the 3-arg form is a zero-copy view over the
  // same backing buffer (as in host/_base64.ts and guest/harness-rpc.ts). Saves
  // a memcpy per chunk of every guest fetch response.
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  emit({ type: "fetch/response-chunk", id, data: view.toString("base64") });
}

async function streamResponseBody(
  response: Response,
  id: string,
  maxResponseBytes: number,
  emit: Emit,
): Promise<boolean> {
  if (!response.body) return true;

  const reader = response.body.getReader();
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      if (!value || value.length === 0) continue;

      totalBytes += value.length;
      if (totalBytes > maxResponseBytes) {
        reader.cancel().catch(() => undefined);
        emitError(id, `Response size exceeded limit of ${maxResponseBytes} bytes`, emit);
        return false;
      }

      for (let offset = 0; offset < value.length; offset += CHUNK_SIZE) {
        emitChunk(id, value.subarray(offset, Math.min(offset + CHUNK_SIZE, value.length)), emit);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function performFetch(
  req: FetchRequest,
  fetchFn: typeof globalThis.fetch | undefined,
  skipSsrf: boolean,
  allowedHosts: string[],
): Promise<Response> {
  // Timeout, SSRF screening, and the per-redirect-hop allowlist re-check all
  // come from the shared policy — see the module comment.
  return performToolFetch(
    req.url,
    {
      method: req.method,
      headers: req.headers,
      ...(req.body !== null ? { body: Buffer.from(req.body, "base64") } : {}),
    },
    { allowedHosts, fetchFn, skipSsrf },
  );
}

export function createFetchHandler(opts: FetchHandlerOptions) {
  const allowedHosts = opts.allowedHosts;
  // Deliberately no `?? globalThis.fetch`: an unset `fetchFn` has to reach
  // `performToolFetch`'s own pinned default. The SSRF layer pins DNS with a
  // dispatcher built from the SDK's undici, which the runtime's bundled undici
  // (a different major) rejects — so a caller-side default here fails every
  // hostname request with a bare `TypeError: fetch failed`. It is also the
  // caller-side duplication the shared-policy module exists to prevent.
  const fetchFn = opts.fetchFn;
  const skipSsrf = opts.skipSsrf ?? false;
  const maxResponseBytes = opts.maxResponseBytes ?? TOOL_FETCH_MAX_RESPONSE_BYTES;

  let activeCount = 0;

  return async function handleFetch(req: FetchRequest, id: string, emit: Emit): Promise<void> {
    // One shared verdict for both execution modes. The guest checks the body
    // size too, but the guest is untrusted — the host is the authoritative
    // side. Base64 decodes to at most 3/4 of its encoded length, which bounds
    // the decoded size without decoding.
    const verdict = checkToolFetch({
      url: req.url,
      allowedHosts,
      activeCount,
      ...(req.body !== null ? { bodyBytes: Math.ceil((req.body.length * 3) / 4) } : {}),
    });
    if (!verdict.ok) {
      emitError(id, verdict.reason, emit);
      return;
    }

    activeCount++;
    try {
      const response = await performFetch(req, fetchFn, skipSsrf, allowedHosts);
      emit({
        type: "fetch/response-start",
        id,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
      });
      if (await streamResponseBody(response, id, maxResponseBytes, emit)) {
        emit({ type: "fetch/response-end", id });
      }
    } catch (err) {
      emitError(id, errorMessage(err), emit);
    } finally {
      activeCount--;
    }
  };
}
