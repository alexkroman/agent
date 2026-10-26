// Copyright 2025 the AAI authors. MIT license.

/**
 * Shared HTTP helper for platform API calls (deploy, delete, secrets).
 *
 * Built on ofetch: JSON bodies are serialized (with Content-Type set) and
 * responses parsed automatically, and transient failures (network errors,
 * 5xx/429) are retried before surfacing an error.
 */

import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { MAX_WORKSPACE_FILE_BYTES, MAX_WORKSPACE_FILES } from "@alexkroman1/aai/workspace-files";
import { FetchError, ofetch } from "ofetch";
import pTimeout from "p-timeout";
import { CliError } from "./_output.ts";

/**
 * `aai login`, not bare `aai`: in a project, bare `aai` offers to PUBLISH,
 * which is the last thing a rejected key should lead to.
 */
export const HINT_INVALID_API_KEY =
  "Your API key may be invalid. Run `aai login` to link your account again.";

/**
 * How long one ATTEMPT may take, response body included, unless the caller
 * says otherwise. With no bound a server that accepts and never answers held
 * `aai list` forever — three times over, once per retry.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * The largest decoded response body accepted — counted as it streams, so a
 * compression bomb is cut off at the cap rather than inflated into memory (a
 * ~1 GB gzip bomb took the CLI to 3 GB RSS).
 *
 * Derived from the biggest legitimate answer, `aai pull`'s whole workspace:
 * at most `MAX_WORKSPACE_FILES` files of `MAX_WORKSPACE_FILE_BYTES`, and JSON
 * spells one byte in at most six characters (`\u0000`), plus slack for the
 * envelope (paths, hashes, a publish's build log). About 162 MB.
 */
export const MAX_RESPONSE_BYTES = MAX_WORKSPACE_FILES * MAX_WORKSPACE_FILE_BYTES * 6 + 8 * 2 ** 20;

/** The server answered a 3xx, which the CLI refuses to follow. */
export class RedirectRefusedError extends Error {
  readonly status: number;
  /** The Location's origin, when the response named one. */
  readonly target: string | undefined;
  constructor(status: number, target: string | undefined) {
    super(`redirected (HTTP ${status})${target ? ` to ${target}` : ""}`);
    this.name = "RedirectRefusedError";
    this.status = status;
    this.target = target;
  }
}

/** One attempt outlived its deadline. */
export class RequestTimeoutError extends Error {
  readonly ms: number;
  constructor(ms: number) {
    super(`no complete response within ${Math.round(ms / 1000)}s`);
    this.name = "RequestTimeoutError";
    this.ms = ms;
  }
}

/** The decoded response body passed its cap while streaming. */
export class ResponseTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`response body exceeded ${Math.round(limit / 2 ** 20)} MiB`);
    this.name = "ResponseTooLargeError";
    this.limit = limit;
  }
}

/** The three refusals {@link guardedFetch} makes — none of which a retry fixes. */
export function isGuardError(
  err: unknown,
): err is RedirectRefusedError | RequestTimeoutError | ResponseTooLargeError {
  return (
    err instanceof RedirectRefusedError ||
    err instanceof RequestTimeoutError ||
    err instanceof ResponseTooLargeError
  );
}

/**
 * `inner`, with the three things a credentialed CLI request must not do by
 * default: follow a redirect, wait forever, or buffer an unbounded body.
 *
 * - **Redirects are refused, never followed** (`redirect: "manual"`, then any
 *   3xx throws). fetch re-sends a 307/308's BODY to the new location, across
 *   origins: `aai secret put` delivered `{"OPENAI_KEY":"sk_live…"}` to the
 *   redirect target and reported success.
 * - **One deadline covers the whole attempt** — headers AND body, since a
 *   server that sends headers and then trickles is the same hang. It wraps
 *   each read with `p-timeout`, so it holds for an injected fetch that ignores
 *   the signal too, and aborts the real request when it fires.
 * - **The decoded body is counted as it streams** and the stream errors past
 *   `maxBytes`.
 *
 * Exported for `aai login`, which talks to the same server with raw fetch.
 */
export function guardedFetch(
  inner: typeof globalThis.fetch,
  limits: { timeoutMs: number; maxBytes: number },
): typeof globalThis.fetch {
  return async (input, init) => {
    const { timeoutMs, maxBytes } = limits;
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const signal = init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    const timedOut = (): never => {
      const err = new RequestTimeoutError(timeoutMs);
      controller.abort(err);
      throw err;
    };
    const res = await pTimeout(inner(input, { ...init, redirect: "manual", signal }), {
      milliseconds: timeoutMs,
      fallback: timedOut,
    });
    // `opaqueredirect` is what a browser-style fetch reports for a manual
    // redirect; Node hands back the real 3xx. 304 is not a redirect.
    if (
      res.type === "opaqueredirect" ||
      (res.status >= 300 && res.status < 400 && res.status !== 304)
    ) {
      await res.body?.cancel().catch(() => undefined);
      throw new RedirectRefusedError(res.status, locationOrigin(res, input));
    }
    if (res.body === null || res.status === 304) return res;
    const reader = res.body.getReader();
    let total = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(out) {
        const chunk = await pTimeout(reader.read(), {
          milliseconds: Math.max(0, deadline - Date.now()),
          fallback: () => {
            void reader.cancel().catch(() => undefined);
            return timedOut();
          },
        });
        if (chunk.done) return out.close();
        total += chunk.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new ResponseTooLargeError(maxBytes);
        }
        out.enqueue(chunk.value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}

/** The origin a redirect points at, resolved against the request URL. */
function locationOrigin(res: Response, input: Parameters<typeof fetch>[0]): string | undefined {
  const location = res.headers.get("location");
  if (location === null) return undefined;
  const base = input instanceof Request ? input.url : String(input);
  return URL.parse(location, base)?.origin ?? location;
}

/** 404 hint for requests scoped to a deployed agent's slug. */
export const HINT_NOT_DEPLOYED =
  "The agent may not be deployed. Check `.aai/project.json` for the correct slug.";

export type ApiRequestOptions = {
  apiKey: string;
  /** Verb used in error messages, e.g. "deploy". */
  action: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /**
   * Request body. Plain objects are JSON-serialized by ofetch (with
   * Content-Type set); binary bodies (e.g. a pre-gzipped Buffer) pass
   * through untouched — set Content-Type/Content-Encoding via `headers`.
   */
  body?: unknown;
  /** Extra request headers, merged with the built-in Authorization header. */
  headers?: Record<string, string>;
  /** Extra error hints keyed by HTTP status. The 401 hint is built in. */
  hints?: Record<number, string>;
  /**
   * Transient-failure retry count (default 2). Pass 0 for requests that are
   * not idempotent server-side — a retry of a request that succeeded but lost
   * its response would perform the action twice (e.g. a first deploy with no
   * slug creates a fresh agent per attempt).
   */
  retry?: number;
  /** Delay between retries in ms (default 300). Tests pass 0 so retry-path
   * assertions don't sleep real wall-clock time. */
  retryDelay?: number;
  /**
   * Per-attempt deadline, response body included (default
   * {@link DEFAULT_REQUEST_TIMEOUT_MS}). A route that legitimately works for
   * minutes — Publish builds in a sandbox — passes its own.
   */
  timeoutMs?: number;
  /** Decoded response cap (default {@link MAX_RESPONSE_BYTES}); tests shrink it. */
  maxResponseBytes?: number;
  /** Optional fetch implementation for testing. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /**
   * Resolve `null` on a 404 instead of throwing — for existence probes
   * ("is there a studio project with this name?") where absence is an
   * answer, not a failure.
   */
  allow404?: boolean;
};

/**
 * The two options a caller only ever supplies from a TEST — a fetch
 * implementation and a zeroed retry delay.
 *
 * ONE declaration, so a wrapper around `apiRequest` (`runDeploy`, `runDelete`)
 * says "plus the test seam" instead of restating both fields and both doc
 * comments. They were written out three times, and the two copies were already
 * spelled differently from each other.
 */
export type ApiTestSeam = Pick<ApiRequestOptions, "fetch" | "retryDelay">;

/**
 * {@link ApiTestSeam} as request options, with absent entries OMITTED rather
 * than passed as `undefined` (which `exactOptionalPropertyTypes` refuses and
 * which would override `apiRequest`'s own defaults with nothing).
 */
export function apiTestSeam(opts: ApiTestSeam): ApiTestSeam {
  return omitUndefined({ fetch: opts.fetch, retryDelay: opts.retryDelay });
}

/**
 * Send an authenticated request to the platform API and return the parsed
 * JSON response. Throws a descriptive error with status-specific hints on
 * failure (the 401 hint is always included; pass more via `hints`).
 */
export async function apiRequest<T = unknown>(url: string, opts: ApiRequestOptions): Promise<T> {
  // A custom fetch implementation must be wired at client-creation time —
  // ofetch ignores a per-request `fetch` option. Always wrapped: see
  // `guardedFetch` for the redirect, deadline and size rules. (ofetch's own
  // `timeout` is not used — it clears once headers arrive, so a trickled body
  // still hung.)
  const fetch = guardedFetch(opts.fetch ?? globalThis.fetch, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxBytes: opts.maxResponseBytes ?? MAX_RESPONSE_BYTES,
  });
  const client = ofetch.create({}, { fetch });
  try {
    return await client<T>(url, {
      method: opts.method ?? "GET",
      headers: { Authorization: `Bearer ${opts.apiKey}`, ...opts.headers },
      ...omitUndefined({ body: opts.body }),
      retry: opts.retry ?? 2,
      retryDelay: opts.retryDelay ?? 300,
      // ofetch retries any error thrown by fetch as if it were a 500. A
      // refused redirect, a timeout or an oversized body would answer the
      // same again (and a hang would cost the deadline once per attempt).
      onRequestError(ctx) {
        if (isGuardError(ctx.error)) ctx.options.retry = false;
      },
    });
  } catch (err) {
    if (opts.allow404 && err instanceof FetchError && err.statusCode === 404) {
      return null as T;
    }
    throw toApiError(err, url, opts);
  }
}

/**
 * A 2xx body CHECKED against the shape the caller was promised, rather than
 * cast to it.
 *
 * `apiRequest<T>` is a cast: `T` describes what the platform sends and nothing
 * verifies it, so a 200 from something that is not our server — an intercepting
 * proxy, a captive portal, a mismatched or half-deployed backend — flows on as
 * a fully-typed object whose fields are `undefined`. That is not hypothetical
 * and not merely cosmetic: a deploy whose response lacked `slug` printed
 * `Deployed https://server/undefined` and wrote `slug: undefined` into
 * `.aai/project.json`, where `JSON.stringify` DROPS it — so the next deploy saw
 * no slug, minted a fresh one, and orphaned the running agent. `aai publish`
 * grew a hand-written guard for exactly that (`studio.ts`); this is that guard
 * with a name, so the next response shape gets it without the incident first.
 *
 * The predicate is the caller's because the shape is: this only owns the
 * failure, whose code and hint are the same wherever it fires.
 */
export function checkedResponse<T>(
  value: unknown,
  isExpected: (value: unknown) => value is T,
  /** The route, named as a human would say it — "the deploy route at <url>". */
  what: string,
): T {
  if (isExpected(value)) return value;
  throw new CliError(
    "bad_response",
    `Unexpected response from ${what}.`,
    "Check that --server points at an aai platform server, then try again.",
  );
}

/** True when every element of `value` is a string (an empty array qualifies). */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Collapse `{"error": "..."}` payloads embedded in a message into their own
 * text. Studio Publish runs the real `aai deploy` inside the sandbox, so its
 * failures arrive wrapped twice and stringifying them produced a
 * triple-escaped wall of JSON around one actionable sentence.
 */
function unwrapEmbeddedErrors(message: string, depth = 0): string {
  if (depth > 3) return message;
  const start = message.indexOf('{"error"');
  if (start === -1) return message;
  const json = message.slice(start);
  try {
    const parsed: unknown = JSON.parse(json);
    const inner = (parsed as { error?: unknown }).error;
    if (typeof inner !== "string") return message;
    return unwrapEmbeddedErrors(message.slice(0, start) + inner, depth + 1);
  } catch {
    return message;
  }
}

/** The messages of a Zod issue tree, deduped and flattened. */
function zodIssueMessages(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(zodIssueMessages);
  // `isRecord`, not an open-coded record guard plus a cast — the narrow is
  // what makes the two field reads below legal (guard-invariants rule 17).
  if (!isRecord(value)) return [];
  // A parent issue's own message ("Invalid key in record") is less specific
  // than its children's, so prefer the leaves when there are any.
  const nested = zodIssueMessages(value.issues);
  if (nested.length > 0) return nested;
  return typeof value.message === "string" ? [value.message] : [];
}

/**
 * A human-readable one-liner for a server error body.
 *
 * Servers answer with `{ error }`, or with a serialized ZodError whose useful
 * part is buried several levels down. Dumping the raw JSON turned a
 * one-character mistake (`aai secret put MY-KEY`) into a 515-character escaped
 * blob, so the shapes we actually emit are unwrapped here and anything else
 * falls back to the raw body rather than being dropped.
 */
export function describeErrorBody(data: unknown): string {
  if (typeof data === "string") return data;
  // Absent or null is NOTHING, so the caller can fall back to the status text.
  if (data === undefined || data === null) return "";
  if (!isRecord(data)) return JSON.stringify(data);
  const error = data.error;
  if (typeof error === "string") return unwrapEmbeddedErrors(error);
  if (isRecord(error)) {
    const { message } = error;
    // zod serializes its issue array into `message` as a JSON string.
    if (typeof message === "string") {
      try {
        const issues = zodIssueMessages(JSON.parse(message));
        if (issues.length > 0) return [...new Set(issues)].join("; ");
      } catch {
        /* not JSON — fall through to the message itself */
      }
      return message;
    }
  }
  return JSON.stringify(data);
}

/** Format an ofetch failure into a descriptive, action-centric error. */
function toApiError(err: unknown, url: string, opts: ApiRequestOptions): Error {
  // A guard refusal arrives bare (thrown while ofetch read the body) or as a
  // FetchError's cause (thrown by the fetch call) — either way it is not a
  // network failure, and "check your network" would send the user the wrong way.
  const guard = err instanceof FetchError ? err.cause : err;
  if (isGuardError(guard)) return guardError(guard, url, opts.action);
  if (err instanceof FetchError && err.statusCode !== undefined) {
    const status = err.statusCode;
    // An empty body (a 431 from a proxy, say) said nothing at all after the
    // colon; the status text at least names the failure.
    const body = describeErrorBody(err.data) || err.statusText || "(empty response)";
    const hint = status === 401 ? HINT_INVALID_API_KEY : opts.hints?.[status];
    return new Error(`${opts.action} failed (HTTP ${status}): ${body}${hint ? `\n  ${hint}` : ""}`);
  }
  const hint = "Check your network connection and verify the server URL is correct.";
  const cause = err instanceof FetchError && err.cause !== undefined ? err.cause : err;
  return new Error(`${opts.action} failed: could not reach ${url}\n  ${hint}`, { cause });
}

/** The sentence for each {@link guardedFetch} refusal, naming what happened. */
function guardError(
  err: RedirectRefusedError | RequestTimeoutError | ResponseTooLargeError,
  url: string,
  action: string,
): Error {
  if (err instanceof RedirectRefusedError) {
    return new Error(
      `${action} failed: ${url} answered with a redirect (HTTP ${err.status})` +
        `${err.target ? ` to ${err.target}` : ""}, and the CLI does not follow redirects.\n` +
        "  Nothing was sent to the redirect target. If the server moved, pass its new URL with --server.",
      { cause: err },
    );
  }
  if (err instanceof RequestTimeoutError) {
    return new Error(
      `${action} failed: ${url} did not finish responding within ${Math.round(err.ms / 1000)}s.\n` +
        "  The server may be overloaded or stuck — try again shortly.",
      { cause: err },
    );
  }
  return new Error(
    `${action} failed: the response from ${url} is larger than ${Math.round(err.limit / 2 ** 20)} MiB, ` +
      "so the CLI stopped reading it.\n  No aai response is that large — check that --server points at an aai platform server.",
    { cause: err },
  );
}
