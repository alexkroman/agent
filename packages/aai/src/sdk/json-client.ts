// Copyright 2026 the AAI authors. MIT license.
/**
 * `jsonClient` — one JSON REST API, called the way every hand-written copy of
 * it called it: a base URL, the credential headers read from the agent's env
 * on each call, a JSON body in, a JSON body out, and a failure that THROWS
 * with the status and what the service said.
 *
 * Every agent that talks to a vendor API had grown this function privately
 * (one per vendor: a memory service, a database's REST API, an OAuth broker),
 * and each copy differed in exactly the places that matter on a bad day — one
 * sliced the error body silently, one returned `undefined` for an empty body
 * where its sibling returned `{}`, one forgot the caller's `signal`, so a
 * barge-in left the request running.
 *
 * ## What it deliberately is NOT
 *
 * - **Not a `T | ToolFailure` answer.** `fetchJson` (`@alexkroman1/aai/tools`)
 *   answers the model; this answers CODE, which wants to branch on a status
 *   (`err.status === 404`) and let everything else propagate. A tool that
 *   hands a failure to the model catches {@link HttpError} and words it.
 * - **Not SSRF-screened.** The base URL is the author's, never the model's;
 *   a model-chosen URL belongs to `fetchJson`.
 * - **Not retrying.** A step's retry is the workflow's; a tool's is a turn.
 *
 * @module json-client
 */

import { isRecord } from "./is-record.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { previewBody, statusWithPreview } from "./response-body.ts";
import { safeJsonParse } from "./safe-json-parse.ts";

/**
 * A refused request from a {@link jsonClient}: the HTTP `status`, a `message`
 * of the form `"<label> <status>: <what the service said>"`, and the parsed
 * `body` (the raw text when it was not JSON; absent when empty).
 *
 * Branch on `status` (`err instanceof HttpError && err.status === 404`), never
 * on the message's wording.
 *
 * @public
 */
export class HttpError extends Error {
  /** The HTTP status the service answered. */
  readonly status: number;
  /** The response body — parsed JSON, else the raw text; absent when empty. */
  readonly body?: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    if (body !== undefined) this.body = body;
  }
}

/**
 * What {@link jsonClient} takes.
 *
 * @public
 */
export interface JsonClientOptions {
  /**
   * The API's base URL, e.g. `"https://api.mem0.ai/v1"`; a request's `path` is
   * appended to it. A FUNCTION reads it from the env on each call (a
   * self-hosted service's URL is configuration). Trailing slashes are dropped.
   */
  baseUrl: string | ((env: Readonly<Partial<Record<string, string>>>) => string);
  /**
   * Headers for every request, typically the credential:
   * `(env) => ({ authorization: \`Token ${requireEnv({ env }, "MEM0_API_KEY")}\` })`.
   * Read per call, so a secret set after start is picked up and a missing one
   * throws where the call is made. Merged over the JSON defaults
   * (`content-type`/`accept: application/json`).
   */
  headers?:
    | Record<string, string>
    | ((env: Readonly<Partial<Record<string, string>>>) => Record<string, string>);
  /** Names the service in every failure message: `"mem0"` → `"mem0 404: …"`. */
  label: string;
  /**
   * The service's own sentence from a refused body — parsed JSON when it
   * parsed, else the raw text. Answer `undefined` to fall back to a preview of
   * the raw body. E.g. `(body) => isRecord(body) && isRecord(body.error) ?
   * String(body.error.message) : undefined`.
   */
  errorMessage?: (body: unknown) => string | undefined;
  /** For TESTS: the `fetch` to call. Defaults to the global one. */
  fetch?: typeof globalThis.fetch;
}

/**
 * The context a {@link JsonClient} call reads: a tool's `ctx`, a route's
 * `ctx`, or `{ env: … }` built from `stepEnv` in a workflow step.
 *
 * @public
 */
export interface JsonClientContext {
  /** The agent's environment — what `headers` and `baseUrl` read. */
  env: Readonly<Partial<Record<string, string>>>;
  /** Cancels the request: pass the tool's or route's own signal. */
  signal?: AbortSignal | undefined;
}

/**
 * Per-call extras for a {@link JsonClient} request.
 *
 * @public
 */
export interface JsonRequestInit {
  /** Headers for this request only, merged over the client's. */
  headers?: Record<string, string>;
}

/**
 * One call to the API a {@link jsonClient} describes. Resolves to the parsed
 * JSON body, or `{}` for an empty one (a `204`); rejects with an
 * {@link HttpError} for a non-2xx, or a 2xx whose body is not JSON.
 *
 * @public
 */
export type JsonClient = <T = unknown>(
  ctx: JsonClientContext,
  method: string,
  path: string,
  body?: unknown,
  init?: JsonRequestInit,
) => Promise<T>;

/**
 * Declare a JSON REST API once, and call it from tools, routes and steps.
 *
 * @example
 * ```ts
 * import { requireEnv } from "@alexkroman1/aai";
 * import { HttpError, jsonClient } from "@alexkroman1/aai/utils";
 *
 * const mem0 = jsonClient({
 *   baseUrl: "https://api.mem0.ai/v1",
 *   headers: (env) => ({ authorization: `Token ${requireEnv({ env }, "MEM0_API_KEY")}` }),
 *   label: "mem0",
 * });
 *
 * export async function forget(ctx: { env: Record<string, string> }, id: string) {
 *   try {
 *     await mem0(ctx, "DELETE", `/memories/${encodeURIComponent(id)}/`);
 *     return true;
 *   } catch (err) {
 *     if (err instanceof HttpError && err.status === 404) return false;
 *     throw err;
 *   }
 * }
 * ```
 *
 * @public
 */
export function jsonClient(options: JsonClientOptions): JsonClient {
  return async <T>(
    ctx: JsonClientContext,
    method: string,
    path: string,
    body?: unknown,
    init?: JsonRequestInit,
  ): Promise<T> => {
    const fetchFn = options.fetch ?? globalThis.fetch;
    const res = await fetchFn(requestUrl(options, ctx, path), {
      method,
      headers: requestHeaders(options, ctx, init),
      ...omitUndefined({
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctx.signal,
      }),
    });
    const text = await res.text().catch(() => "");
    const parsed = text === "" ? undefined : safeJsonParse(text);
    if (!res.ok) throw refusal(options, res.status, text, parsed);
    if (text === "") return {} as T;
    // `undefined` is safeJsonParse saying "not JSON" — JSON cannot encode it.
    if (parsed === undefined) {
      throw new HttpError(res.status, statusWithPreview(res.status, text, options.label), text);
    }
    return parsed as T;
  };
}

function requestUrl(options: JsonClientOptions, ctx: JsonClientContext, path: string): string {
  const base = typeof options.baseUrl === "function" ? options.baseUrl(ctx.env) : options.baseUrl;
  return `${base.replace(/\/+$/, "")}${path}`;
}

function requestHeaders(
  options: JsonClientOptions,
  ctx: JsonClientContext,
  init: JsonRequestInit | undefined,
): Record<string, string> {
  const own = typeof options.headers === "function" ? options.headers(ctx.env) : options.headers;
  return {
    "content-type": "application/json",
    accept: "application/json",
    ...own,
    ...init?.headers,
  };
}

/** The {@link HttpError} a non-2xx is thrown as. */
function refusal(
  options: JsonClientOptions,
  status: number,
  text: string,
  parsed: unknown,
): HttpError {
  const said = parsed ?? (text === "" ? undefined : text);
  const detail = said === undefined ? undefined : sentence(options.errorMessage, said);
  const message =
    detail === undefined
      ? statusWithPreview(status, text, options.label)
      : `${options.label} ${status}: ${previewBody(detail)}`;
  return new HttpError(status, message, said);
}

/** The author's reading of a refused body, else the common `{ error }` / `{ message }` shapes. */
function sentence(
  read: ((body: unknown) => string | undefined) | undefined,
  body: unknown,
): string | undefined {
  const own = read?.(body)?.trim();
  if (own) return own;
  if (!isRecord(body)) return undefined;
  for (const field of [body.error, body.message]) {
    if (typeof field === "string" && field.trim() !== "") return field.trim();
    if (isRecord(field) && typeof field.message === "string" && field.message.trim() !== "") {
      return field.message.trim();
    }
  }
  return undefined;
}
