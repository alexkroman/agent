// Copyright 2026 the AAI authors. MIT license.
/**
 * The egress policy for one fetch made by an agent's own tool code — the
 * single implementation both execution modes are routed through.
 *
 * There are two places tool code can run, and they used to police it
 * differently:
 *
 * - **Platform**: the guest has no network device, so its `fetch` is RPC-proxied
 *   and the host decides (`aai-server/sandbox-fetch.ts`).
 * - **Self-hosted** (`aai dev`): no sandbox at all, so tool code reached the
 *   real `globalThis.fetch` with nothing checked (`host/tool-egress.ts`).
 *
 * That gap meant an undeclared host, an oversized body, or a slow endpoint
 * worked all through local development and only failed after deploy. The fix
 * is not two matching implementations — it is one. {@link checkToolFetch}
 * returns the verdict and {@link performToolFetch} performs the call; a check
 * added to either is a check both modes get, and neither side holds a limit of
 * its own.
 *
 * **Adding a limit:** put the number in `sdk/constants.ts`, enforce it in
 * `checkToolFetch` (pre-flight) or `performToolFetch` (transport), and both
 * modes inherit it. Do not add a check to a caller — a caller-side check is
 * exactly the drift this module exists to prevent. The one deliberate
 * exception is response-body size: the platform must enforce it while relaying
 * chunks over NDJSON and self-hosted mode while handing back a `Response`, so
 * the *mechanism* differs. {@link TOOL_FETCH_MAX_RESPONSE_BYTES} is still the
 * only number, and {@link capResponseBody} is the self-hosted half.
 */

import { matchesAllowedHost } from "../sdk/allowed-hosts.ts";
import {
  TOOL_FETCH_MAX_CONCURRENT,
  TOOL_FETCH_MAX_REQUEST_BODY_BYTES,
  TOOL_FETCH_MAX_RESPONSE_BYTES,
  TOOL_FETCH_TIMEOUT_MS,
} from "../sdk/constants.ts";
import { pinnedFetch, ssrfSafeFetch } from "./ssrf.ts";

// Re-exported so a consumer never has a reason to reach past this module for
// the numbers it enforces.
export {
  TOOL_FETCH_MAX_CONCURRENT,
  TOOL_FETCH_MAX_REQUEST_BODY_BYTES,
  TOOL_FETCH_MAX_RESPONSE_BYTES,
  TOOL_FETCH_TIMEOUT_MS,
} from "../sdk/constants.ts";

/** A rejected fetch, with the message the tool author sees in either mode. */
export type ToolFetchRejection = { ok: false; reason: string };
export type ToolFetchVerdict = { ok: true; url: URL } | ToolFetchRejection;

/** What {@link checkToolFetch} needs to know about one pending fetch. */
export type ToolFetchRequest = {
  /** Target URL, unparsed — a malformed URL is one of the rejections. */
  url: string;
  /** Decoded request-body size in bytes, or 0/undefined when there is no body. */
  bodyBytes?: number | undefined;
  /** Hostnames this agent declared, plus any derived (e.g. a send channel's). */
  allowedHosts: readonly string[];
  /** Fetches already in flight for this agent, for the concurrency cap. */
  activeCount?: number | undefined;
};

/**
 * Decide whether one tool fetch may proceed.
 *
 * Ordered so the cheapest and most likely-to-be-actionable rejection wins:
 * a developer who has hit the concurrency cap and *also* forgotten to declare
 * the host is told about the cap first, because that is the condition their
 * next attempt changes.
 */
export function checkToolFetch(req: ToolFetchRequest): ToolFetchVerdict {
  const activeCount = req.activeCount ?? 0;
  if (activeCount >= TOOL_FETCH_MAX_CONCURRENT) {
    return { ok: false, reason: `Fetch concurrent limit of ${TOOL_FETCH_MAX_CONCURRENT} exceeded` };
  }

  if ((req.bodyBytes ?? 0) > TOOL_FETCH_MAX_REQUEST_BODY_BYTES) {
    return {
      ok: false,
      reason: `Request body exceeds ${TOOL_FETCH_MAX_REQUEST_BODY_BYTES} byte limit`,
    };
  }

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return { ok: false, reason: `Invalid URL: ${req.url}` };
  }

  if (!matchesAllowedHost(url.hostname, [...req.allowedHosts])) {
    return {
      ok: false,
      reason: `Host "${url.hostname}" is not allowed. Add it to the agent's allowedHosts list.`,
    };
  }

  return { ok: true, url };
}

/**
 * Perform an already-approved tool fetch: SSRF-screened, allowlist re-checked
 * on every redirect hop, and time-boxed.
 *
 * `skipSsrf` exists for tests that need to reach a loopback server; production
 * and `aai dev` both leave it off.
 */
export function performToolFetch(
  url: string,
  init: RequestInit,
  opts: {
    allowedHosts: readonly string[];
    fetchFn?: typeof globalThis.fetch | undefined;
    skipSsrf?: boolean | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<Response> {
  // `pinnedFetch`, not `globalThis.fetch`: `ssrfSafeFetch` attaches a
  // dispatcher built from this package's undici, and only that package's
  // `fetch` accepts it. See the note on `pinnedFetch`.
  const fetchFn = opts.fetchFn ?? pinnedFetch;
  const timeout = AbortSignal.timeout(TOOL_FETCH_TIMEOUT_MS);
  const withTimeout: RequestInit = {
    ...init,
    // A caller-supplied signal (turn cancellation) must still win, so combine
    // rather than replace — dropping it would leave a barge-in waiting out the
    // full timeout.
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  };
  return opts.skipSsrf
    ? fetchFn(url, withTimeout)
    : ssrfSafeFetch(url, withTimeout, fetchFn, {
        isHostAllowed: (h) => matchesAllowedHost(h, [...opts.allowedHosts]),
      });
}

/**
 * Wrap a response so reading more than {@link TOOL_FETCH_MAX_RESPONSE_BYTES}
 * fails — the self-hosted half of the response cap the platform applies while
 * relaying chunks.
 *
 * Counts streamed bytes rather than trusting `content-length`, which is absent
 * on chunked responses and is attacker-controlled besides.
 */
export function capResponseBody(response: Response): Response {
  if (!response.body) return response;
  let seen = 0;
  const capped = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > TOOL_FETCH_MAX_RESPONSE_BYTES) {
          controller.error(
            new TypeError(`Response exceeds ${TOOL_FETCH_MAX_RESPONSE_BYTES} byte limit`),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(capped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
