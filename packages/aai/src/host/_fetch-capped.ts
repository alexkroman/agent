// Copyright 2026 the AAI authors. MIT license.
/**
 * One bounded fetch for every builtin that reads a model-controlled URL.
 *
 * Five call sites — `visit_webpage`, `fetch_json`, `get_page_design`'s page and
 * stylesheet reads, and `web_search`'s two endpoints — used to restate the same
 * four lines: the `User-Agent`/`Accept` pair, `AbortSignal.timeout`, the
 * `!resp.ok` shape, and `await resp.text()`. The last of those was the bug they
 * shared.
 *
 * **The cap has to bound the READ, not the value that is kept.** Every site did
 * `const body = await resp.text()` and only then sliced or refused it, so the
 * body was fully buffered into host memory first and the "cap" bounded nothing:
 * the real limit was {@link FETCH_TIMEOUT_MS} times the link's bandwidth, on a
 * URL a prompt injection picks. `fetch_json` additionally pre-checked
 * `content-length`, which reads `Number(null)` → `0` for any chunked response
 * and therefore passed the guard exactly when the body was unbounded. So the
 * body is read here through `resp.body.getReader()`, one chunk at a time,
 * stopping the moment the budget is exceeded and cancelling the stream.
 *
 * **And the budget is in BYTES.** The old caps compared `String.length` — UTF-16
 * code units — against a byte budget, so a body of multi-byte characters passed
 * at up to ~3x its nominal size. Chunks arrive as bytes, so counting them is
 * both cheaper and the thing the budget actually means.
 *
 * `truncated` is the caller's decision to make, and the two answers are both
 * right: a page is worth reading in part, where a JSON document clipped mid-value
 * is not parseable and must be refused.
 */

import { FETCH_TIMEOUT_MS, TOOL_USER_AGENT } from "../sdk/constants.ts";

/** Options for {@link fetchCappedText}. @internal */
export type FetchCappedOptions = {
  /** The fetch to use — callers pass their SSRF-screened one. */
  fetch: typeof globalThis.fetch;
  /** Hard ceiling, in BYTES, on how much of the body is read off the wire. */
  maxBytes: number;
  /**
   * `Accept` for a builtin request. Setting it also sends
   * {@link TOOL_USER_AGENT}, since the two travel together at every site that
   * wants either; omit it for a request whose headers the caller owns outright.
   */
  accept?: string | undefined;
  /** Extra headers, merged over (and able to replace) the pair above. */
  headers?: Record<string, string> | undefined;
};

/**
 * A bounded read, or the HTTP failure that stopped it.
 *
 * `error` is the bare `"<status> <statusText>"` because the five callers prefix
 * it differently ("Failed to fetch: ", "HTTP ", "Search request failed: ") and
 * those strings are what the model reads.
 *
 * @internal
 */
export type CappedText =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; status: number; statusText: string; error: string };

/** Read at most `maxBytes` bytes of a stream, then cancel it. */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      chunks.push(value);
      total += value.byteLength;
      // One chunk past the budget is what makes "exactly at the cap" and "there
      // was more" distinguishable; the surplus is dropped by the concat below.
      if (total > maxBytes) break;
    }
  } finally {
    await reader.cancel().catch(() => {
      // The stream may already be errored or closed; nothing is owed here.
    });
  }
  const truncated = total > maxBytes;
  return {
    text: Buffer.concat(chunks, Math.min(total, maxBytes)).toString("utf8"),
    truncated,
  };
}

/**
 * Fetch a URL and read at most `maxBytes` bytes of its body as UTF-8 text.
 *
 * Throws only what `fetch` itself throws (a network failure, an SSRF rejection,
 * the timeout) — an HTTP failure is answered as `{ ok: false }`, because every
 * caller turns one into a tool result rather than a thrown turn.
 *
 * @internal
 */
export async function fetchCappedText(url: string, opts: FetchCappedOptions): Promise<CappedText> {
  const preamble =
    opts.accept === undefined ? undefined : { "User-Agent": TOOL_USER_AGENT, Accept: opts.accept };
  const resp = await opts.fetch(url, {
    headers: { ...preamble, ...opts.headers },
    // A fresh {@link FETCH_TIMEOUT_MS} deadline over headers AND body, always.
    // There used to be a caller-supplied `signal` here that REPLACED it, which
    // no caller ever passed and which would have silently retired this module's
    // own byte-read deadline for whoever did.
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    // Nothing reads a failed body, and an undrained one keeps the connection
    // pinned until the timeout.
    await resp.body?.cancel().catch(() => {
      // Already closed — see readCapped.
    });
    return {
      ok: false,
      status: resp.status,
      statusText: resp.statusText,
      error: `${resp.status} ${resp.statusText}`,
    };
  }
  // A bodyless response (204, HEAD) has nothing to read and nothing to cap.
  if (!resp.body) return { ok: true, text: "", truncated: false };
  return { ok: true, ...(await readCapped(resp.body, opts.maxBytes)) };
}
