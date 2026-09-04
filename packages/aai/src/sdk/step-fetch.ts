// Copyright 2026 the AAI authors. MIT license.
/**
 * `stepFetch()` — the HTTP call a step should make, and
 * `multipartBody()` — how it attaches a file.
 *
 * A step's whole job is usually one outbound request, and `globalThis.fetch` is
 * the wrong one to make it with. Not for a reason anybody could infer from a
 * call site, which is why this is a primitive rather than a paragraph:
 *
 * ## `fetch` speaks HTTP/2 now, and a fan-out is the worst case for that
 *
 * undici 8 — the copy backing `globalThis.fetch` from Node 26 — flipped
 * `allowH2` to `true` (`lib/core/connect.js`: `allowH2 = allowH2 != null ?
 * allowH2 : true`). So `fetch` offers `h2` in ALPN and the far side decides. A
 * server that takes it gets every concurrent request from this process
 * **multiplexed onto ONE TCP connection**, sharing one flow-control window —
 * which is fine for the small JSON calls most code makes and pathological for
 * the shape a workflow fan-out has, N large bodies in flight at once.
 *
 * Measured against AssemblyAI's sync transcription endpoint, 8 concurrent
 * 17.66 MB uploads, same bytes and key, one minute apart:
 *
 * | transport | landed | p50 | throughput |
 * | --- | --- | --- | --- |
 * | `globalThis.fetch` (h2) | 14/16 | 8094ms | 20.8 MB/s |
 * | HTTP/1.1 | 16/16 | 3719ms | 29.9 MB/s |
 * | HTTP/1.1, keep-alive pool | 16/16 | 3037ms | 38.6 MB/s |
 *
 * ## The lost requests matter more than the 2.7x, and this is the part to carry
 *
 * **On HTTP/2 a capacity limit arrives as a STREAM RESET, and a stream error
 * carries no HTTP status.** `NGHTTP2_ENHANCE_YOUR_CALM` is the limit saying so
 * by name; `NGHTTP2_INTERNAL_ERROR` is the connection window giving out first.
 * Neither is visible to {@link isTransientStatus} or {@link retryAfter} —
 * there is no response to read — so a bounded fan-out retries every sibling in
 * lockstep into the same reset, exhausts its `maxRetries`, and fails the run
 * with `TypeError: fetch failed`, whose real cause sits two `cause` hops down
 * where nothing prints it.
 *
 * Over HTTP/1.1 the identical limit arrives as `503` (or `429`) with
 * `retry-after`, which the retry helpers already read correctly. So the fix is
 * not "handle h2 resets"; it is **let the far side answer in HTTP**. Verified
 * end to end: the same 65-segment run that failed on `fetch` completes on
 * HTTP/1.1 at every concurrency up to 48, and at 64 pays 20 retried `503`s
 * instead of dying.
 *
 * ## What it is, mechanically
 *
 * A published slot, the mechanism {@link stepEnv} and {@link report} use and for
 * the same reason: the HTTP/1.1 dispatcher needs `undici`, this module is on the
 * CLI's zero-dependency startup path and rides the browser bundle, and a step
 * artifact carries its own copy of this file — so the publisher and the reader
 * are two module instances in one realm. `createServer` publishes;
 * `host/step-fetch.ts` is the published half.
 *
 * An UNPUBLISHED slot falls back to `globalThis.fetch`, which is what keeps an
 * exported step callable from a spec that stubs the global — the same rule
 * {@link stepEnv} follows for `process.env`.
 *
 * ```ts no-check
 * import { multipartBody, stepFetch } from "@alexkroman1/aai/step";
 *
 * export async function transcribe(bytes: Uint8Array) {
 *   const part = multipartBody({ name: "audio", filename: "clip.wav", type: "audio/wav", bytes });
 *   const response = await stepFetch("https://sync.assemblyai.com/transcribe", {
 *     method: "POST",
 *     headers: { Authorization: requireStepEnv("ASSEMBLYAI_API_KEY"), ...part.headers },
 *     body: part.body,
 *   });
 * }
 * ```
 */

import { concatBytes } from "./_bytes.ts";

/**
 * The subset of `fetch` a step needs, and all a host has to publish.
 *
 * @internal
 */
export type StepFetch = (url: string, init?: StepFetchInit) => Promise<Response>;

/**
 * What {@link stepFetch} accepts.
 *
 * Deliberately NARROWER than `RequestInit`, and the narrowing is the API's main
 * safety property. A `FormData`, `Blob`, `File`, `Headers` or `Request` handed
 * to a `fetch` that is not the one your realm's global came from is
 * brand-checked against that other undici's classes, matches no branch, and is
 * silently stringified — `Content-Type: text/plain` with the 17-byte body
 * `[object FormData]`, answered `415` by a server that was told nothing.
 * `body` therefore takes BYTES or a string, and {@link multipartBody} is how a
 * file becomes bytes.
 */
export type StepFetchInit = {
  method?: string | undefined;
  /** Plain record, not a `Headers` — see the type's own doc for why. */
  headers?: Record<string, string> | undefined;
  /**
   * The request body: bytes, a string, or an async iterable of chunks.
   *
   * The iterable form is what lets a step send a file it must not hold in memory —
   * a stored upload read window by window, which is the only way a step can hand a
   * multi-gigabyte recording to another service. It requires `duplex: "half"`, which
   * the published fetch adds; the caller passes only the iterable.
   *
   * Note a streaming body cannot be RETRIED by the transport, because an iterable is
   * consumed once. That is a property of streaming rather than of this option, and it
   * is why a step sending one should be the step the engine retries — a fresh attempt
   * re-reads the upload from the start.
   */
  body?: Uint8Array | string | AsyncIterable<Uint8Array> | undefined;
  signal?: AbortSignal | undefined;
};

/** The registry-wide slot — see the module doc for why it is not a module-level `let`. */
const STEP_FETCH_SLOT = Symbol.for("@alexkroman1/aai.stepFetch");

/** The shape stored in the slot. `undefined` means nothing has published. */
type StepFetchSlot = { [STEP_FETCH_SLOT]?: StepFetch };

/**
 * Publish the HTTP/1.1 fetch for this process's steps.
 *
 * `createServer` does this, which is what makes a step's outbound calls behave
 * identically under `aai dev`, on a self-hosted server and in a deployed guest.
 * Pass `undefined` to unpublish.
 *
 * @internal — a host concern, exported from `@alexkroman1/aai-runtime`. A step
 * author calls {@link stepFetch}.
 */
export function publishStepFetch(fetchFn: StepFetch | undefined): void {
  if (fetchFn === undefined) delete (globalThis as StepFetchSlot)[STEP_FETCH_SLOT];
  else (globalThis as StepFetchSlot)[STEP_FETCH_SLOT] = fetchFn;
}

/**
 * Does this body arrive in CHUNKS, i.e. does `fetch` need `duplex: "half"`?
 *
 * Narrowed off the declared union rather than by a `typeof … === "object" &&
 * … !== null` test, which is the open-coded record guard `guard-invariants`
 * rule 17 exists to keep out — and `isRecord` is not the remedy here, because an
 * async iterable is not a record. Excluding the two non-object arms is enough:
 * what is left is bytes (which `fetch` buffers) or a stream.
 */
function isStreamingBody(body: StepFetchInit["body"]): boolean {
  if (body === undefined || typeof body === "string") return false;
  return !(ArrayBuffer.isView(body) || body instanceof ArrayBuffer || body instanceof Blob);
}

/**
 * Make one HTTP request from inside a step.
 *
 * Prefer this to `fetch` in any step, and especially in a
 * fan-out: it pins HTTP/1.1 (so a concurrent batch gets a socket each rather
 * than N streams on one connection), reuses connections across a fan-out's
 * calls, and reports a connection failure with its whole `cause` chain instead
 * of a bare `TypeError: fetch failed`.
 *
 * @remarks
 * **`globalThis.fetch` speaks HTTP/2 now, and a fan-out is the worst case for
 * that.** undici 8 — the copy backing it from Node 26 — defaults `allowH2` to
 * true, so every concurrent request from one process is multiplexed onto ONE TCP
 * connection sharing one flow-control window. Measured against AssemblyAI's sync
 * transcription endpoint, 8 concurrent 17.66 MB uploads, same bytes and key, one
 * minute apart:
 *
 * | transport | landed | p50 | throughput |
 * | --- | --- | --- | --- |
 * | `globalThis.fetch` (h2) | 14/16 | 8094ms | 20.8 MB/s |
 * | HTTP/1.1 | 16/16 | 3719ms | 29.9 MB/s |
 * | HTTP/1.1, keep-alive pool | 16/16 | 3037ms | 38.6 MB/s |
 *
 * **The two lost requests matter more than the 2.7x.** On HTTP/2 a capacity
 * limit arrives as a stream reset, and a stream error carries no HTTP status —
 * so neither {@link isTransientStatus} nor {@link retryAfter} can see it, every
 * sibling in a bounded fan-out retries in lockstep into the same reset, and the
 * run dies on `TypeError: fetch failed` with its real cause two `cause` hops
 * down. Over HTTP/1.1 the identical limit arrives as a `503` or `429` carrying
 * `retry-after`, which those helpers already read. Verified end to end: the same
 * 65-segment run that failed on `fetch` completes on HTTP/1.1 at every
 * concurrency up to 48, and at 64 pays 20 retried `503`s instead of dying.
 *
 * @throws {StepTransportError} when the request never got an answer — a reset
 *   connection, a DNS failure, a timeout. Distinct from a response with a bad
 *   status, which is returned like any other: only the caller knows whether a
 *   `404` is fatal.
 * @public
 *
 * **From a step, prefer `stepFetchOrFail`
 * (`@alexkroman1/aai/step-errors`).** The engine's retry policy is decided by WHICH
 * error a step throws, and raw every failure looks alike to it — a bad API key is
 * retried until the attempts run out. It also turns a non-2xx into a throw, which `stepFetch` deliberately does not.
 */
export async function stepFetch(url: string, init: StepFetchInit = {}): Promise<Response> {
  const published = (globalThis as StepFetchSlot)[STEP_FETCH_SLOT];
  try {
    if (published) return await published(url, init);
    // No host in this process — a spec, or a script calling an exported step.
    // The global is the only fetch there is, and a spec that stubs it is the
    // ordinary way a step's HTTP is tested.
    //
    // `duplex: "half"` for a STREAMING body, because `undici` requires it and
    // refuses without one: `TypeError: RequestInit: duplex option is required
    // when sending a body`. `StepFetchInit.body`'s own doc has always said the
    // published fetch adds it and the caller passes only the iterable — and
    // this path added nothing, so the promise held for a deployed run and broke
    // for every other caller. Measured on a real upload: `stepTranscribeUpload`
    // streams window by window, so a `spoken-summary` run driven from an eval or
    // a spec died before it reached the provider. Only the streaming form needs
    // it (bytes and strings are already buffered), and adding it unconditionally
    // is not free — a `duplex` on a bodiless GET is a different rejection.
    const streaming = isStreamingBody(init.body);
    return await globalThis.fetch(
      url,
      (streaming ? { ...init, duplex: "half" } : init) as RequestInit,
    );
  } catch (err: unknown) {
    throw new StepTransportError(url, { cause: err });
  }
}

/**
 * A request that never got an answer.
 *
 * Its own class because the DISTINCTION is what a retry policy turns on: a
 * response with a status can be classified ({@link isTransientStatus},
 * {@link retryAfter}), and this cannot — so a caller's choice is between
 * retrying a connection failure and giving up on one, with nothing to read.
 * Retrying is almost always right, which is why {@link StepTransportError} is
 * what the SDK raises rather than making every step write the `catch`.
 *
 * The message carries the whole `cause` chain, because the top of one never says
 * anything useful: `TypeError: fetch failed` and `socket hang up` are wrappers,
 * and the code that identifies the failure — `ECONNRESET`, `UND_ERR_SOCKET`,
 * `ETIMEDOUT`, `ERR_HTTP2_STREAM_ERROR` — is a hop or two below.
 *
 * @public
 */
export class StepTransportError extends Error {
  /** Every `code` in the chain, outermost first — what a caller would branch on. */
  readonly codes: readonly string[];

  constructor(url: string, options: { cause: unknown }) {
    const chain = causeChain(options.cause);
    // The HOST rather than the whole URL, because a step's URL routinely carries
    // a token in a query parameter and this message reaches a run's error field.
    // Parsed defensively: an unparsable URL is its own failure and must not
    // replace the transport one being reported.
    super(`${hostOf(url)} did not answer: ${chain.map((one) => one.text).join(" <- ")}`, {
      cause: options.cause,
    });
    this.name = "StepTransportError";
    this.codes = chain.flatMap((one) => (one.code === undefined ? [] : [one.code]));
  }
}

/** A URL's host, or the URL itself when it will not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Every message and code in an error's `cause` chain, outermost first. */
function causeChain(err: unknown): { text: string; code?: string }[] {
  const chain: { text: string; code?: string }[] = [];
  let at: unknown = err;
  // Bounded rather than looped to exhaustion: a `cause` cycle is representable,
  // and five hops is past every real chain undici and node:http produce.
  for (let hop = 0; hop < 5 && at !== undefined && at !== null; hop += 1) {
    const node = at as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    const code = typeof node.code === "string" ? node.code : undefined;
    const name = typeof node.name === "string" ? node.name : "Error";
    const message = typeof node.message === "string" ? node.message : String(at);
    chain.push({ text: `${name}: ${message}${code ? ` [${code}]` : ""}`, ...(code && { code }) });
    at = node.cause;
  }
  return chain;
}

/** One file part, as {@link multipartBody} takes it. */
export type MultipartPart = {
  /** The form field name the endpoint reads. */
  name: string;
  /**
   * The bytes, as one buffer or as the chunks they already are.
   *
   * A LIST is concatenated into the body in order and is indistinguishable on
   * the wire from the same content passed as one buffer. It exists so a caller
   * holding a payload in pieces — a {@link wavHeader} in front of the samples it
   * describes, a file read window by window — need not JOIN them first only for
   * this function to copy the join into the body: for a multi-megabyte part that
   * intermediate buffer is a second full copy of the payload, held at the same
   * time as the first. The body itself is still one buffer, which is what buys
   * `Content-Length` and a retryable request; this removes the copy in front of
   * it, not the one it is.
   */
  bytes: Uint8Array | readonly Uint8Array[];
  /** Filename to declare. Omitted makes this an ordinary field rather than a file. */
  filename?: string | undefined;
  /** Content type of the part. Defaults to `application/octet-stream` for a file. */
  type?: string | undefined;
};

/** A ready-to-send multipart body, as {@link multipartBody} returns it. */
export type MultipartBody = {
  /** The whole encoded body. */
  body: Uint8Array;
  /** The `Content-Type` naming the boundary — spread into `headers`. */
  headers: { "Content-Type": string };
};

/**
 * Encode `multipart/form-data` as BYTES.
 *
 * The reason this exists rather than `new FormData()`: a `FormData` is a branded
 * object, and handing one to a `fetch` from a different undici than your realm's
 * global silently sends the string `[object FormData]` — see
 * {@link StepFetchInit}. Bytes cannot be got wrong that way, and a step's
 * multipart body is always one or two known parts rather than a form somebody
 * filled in.
 *
 * The boundary is generated per call and is not derived from the content, so a
 * body containing the boundary token is astronomically unlikely rather than
 * impossible; endpoints behave the same way.
 *
 * **A part's `name` and `filename` are ESCAPED, because they are the one thing
 * here that is routinely not the author's own string.** An upload's `name` is
 * "the filename the uploader gave" (`stepUploadInfo`), so it reaches a step from a
 * browser form and lands in a header this function writes — and a `"`, a CR or
 * an LF in it closed the quoted string and appended headers of the caller's
 * choosing to the request. The escaping is the HTML form-encoding algorithm's,
 * which is what the `FormData` this replaces would have applied: `"` becomes
 * `%22`, CR `%0D`, LF `%0A`.
 *
 * @public
 */
export function multipartBody(...parts: readonly MultipartPart[]): MultipartBody {
  const boundary = `----aai${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const disposition =
      part.filename === undefined ? "" : `; filename="${escapeHeaderQuoted(part.filename)}"`;
    const type =
      part.filename === undefined
        ? ""
        : `Content-Type: ${part.type ?? "application/octet-stream"}\r\n`;
    chunks.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${escapeHeaderQuoted(part.name)}"${disposition}\r\n${type}\r\n`,
      ),
    );
    // Spread with a loop rather than `chunks.push(...part.bytes)`: the argument
    // list is bounded by the stack, and a part's chunk count is the caller's
    // business rather than something this can promise stays at two.
    if (part.bytes instanceof Uint8Array) chunks.push(part.bytes);
    else for (const chunk of part.bytes) chunks.push(chunk);
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  return {
    body: concatBytes(chunks),
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
  };
}

/**
 * A field or file name as it may appear inside a quoted header value.
 *
 * The HTML spec's `multipart/form-data` escape, so a name survives round-tripping
 * through an endpoint's parser rather than being stripped: the three characters
 * that can end the quoted string or the header line become percent escapes, and
 * nothing else is touched (a `%` is deliberately left alone — escaping it too
 * would rewrite every ordinary name that contains one).
 */
function escapeHeaderQuoted(value: string): string {
  return value.replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22");
}
