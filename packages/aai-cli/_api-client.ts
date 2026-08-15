// Copyright 2025 the AAI authors. MIT license.

/**
 * Shared HTTP helper for platform API calls (deploy, delete, secrets).
 *
 * Built on ofetch: JSON bodies are serialized (with Content-Type set) and
 * responses parsed automatically, and transient failures (network errors,
 * 5xx/429) are retried before surfacing an error.
 */

import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { FetchError, ofetch } from "ofetch";

export const HINT_INVALID_API_KEY =
  "Your API key may be invalid. Run `aai` to re-enter your AssemblyAI API key.";

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
 * Send an authenticated request to the platform API and return the parsed
 * JSON response. Throws a descriptive error with status-specific hints on
 * failure (the 401 hint is always included; pass more via `hints`).
 */
export async function apiRequest<T = unknown>(url: string, opts: ApiRequestOptions): Promise<T> {
  // A custom fetch implementation must be wired at client-creation time —
  // ofetch ignores a per-request `fetch` option.
  const client = opts.fetch ? ofetch.create({}, { fetch: opts.fetch }) : ofetch;
  try {
    return await client<T>(url, {
      method: opts.method ?? "GET",
      headers: { Authorization: `Bearer ${opts.apiKey}`, ...opts.headers },
      ...omitUndefined({ body: opts.body }),
      retry: opts.retry ?? 2,
      retryDelay: opts.retryDelay ?? 300,
    });
  } catch (err) {
    if (opts.allow404 && err instanceof FetchError && err.statusCode === 404) {
      return null as T;
    }
    throw toApiError(err, url, opts);
  }
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
  if (value === null || typeof value !== "object") return [];
  const node = value as { message?: unknown; issues?: unknown };
  // A parent issue's own message ("Invalid key in record") is less specific
  // than its children's, so prefer the leaves when there are any.
  const nested = zodIssueMessages(node.issues);
  if (nested.length > 0) return nested;
  return typeof node.message === "string" ? [node.message] : [];
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
  if (!isRecord(data)) return JSON.stringify(data ?? "");
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
  if (err instanceof FetchError && err.statusCode !== undefined) {
    const status = err.statusCode;
    const body = describeErrorBody(err.data);
    const hint = status === 401 ? HINT_INVALID_API_KEY : opts.hints?.[status];
    return new Error(`${opts.action} failed (HTTP ${status}): ${body}${hint ? `\n  ${hint}` : ""}`);
  }
  const hint = "Check your network connection and verify the server URL is correct.";
  const cause = err instanceof FetchError && err.cause !== undefined ? err.cause : err;
  return new Error(`${opts.action} failed: could not reach ${url}\n  ${hint}`, { cause });
}
