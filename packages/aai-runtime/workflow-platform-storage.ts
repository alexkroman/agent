// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest's Storage, as HTTP calls to the platform.
 *
 * The DevKit's `Storage` is eleven methods across four groups, and every one of
 * them becomes the same request: `POST <base>/workflow-storage` with
 * `{ method, args }`. So this module is a PROXY rather than an implementation —
 * there is no run state here, no query, and nothing that could disagree with the
 * platform about what a run is.
 *
 * ## Binary is the whole difficulty
 *
 * At `specVersion >= 2` a run's `input` and `output`, a step's `input` and
 * `output`, and a hook's `metadata` are `Uint8Array`. `JSON.stringify` turns one
 * into an index map and nothing errors — the run simply starts with garbage. So
 * both directions go through `workflow-typed-json.ts`, which is the DevKit's own
 * envelope format, and the platform's route uses the same module. One codec, two
 * sides, no drift.
 *
 * ## The method list is spelled here AND on the platform
 *
 * Deliberately, and it is the one duplication in this design. The platform's copy
 * is a security boundary — its `STORAGE_SCOPES` decides how each method is scoped
 * to an agent, and a method missing from it must be REFUSED rather than defaulted.
 * A shared list would make "the platform serves it" and "the guest asks for it"
 * one fact, and they are two: a guest asking for something the platform will not
 * scope should get a 400, not a pass-through. The failure of a mismatch is
 * therefore loud and safe in the direction that matters.
 *
 * ## What is NOT here
 *
 * Pagination, filtering and `resolveData` are all the caller's params, forwarded
 * untouched. The one place the platform answers differently is `runs.list`, which
 * it builds from its ownership table — and it returns their own paginated shape, so
 * nothing here needs to know.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import { WorkflowRunNotFoundError } from "workflow/errors";
import { egressFetch } from "./_egress-fetch.ts";
import { PLATFORM_ROUTES, type PlatformEndpoint, platformUrl } from "./platform-endpoint.ts";
import { platformBearer, platformPost } from "./platform-rpc.ts";
import { storageErrorForStatus } from "./workflow-storage-status.ts";
import { decodeStorageJson, encodeStorageJson } from "./workflow-typed-json.ts";

/**
 * How long one storage call may take.
 *
 * A single indexed read or one transaction on the platform's database, over the
 * platform's own network — so this bounds a hung socket rather than real work. A
 * step is BLOCKED on it (the DevKit awaits storage inside a replay), so it is short
 * for the same reason the enqueue timeout is.
 */
const STORAGE_TIMEOUT_MS = 15_000;

/** One Storage method, as this client presents it. */
type StorageFn = (...args: unknown[]) => Promise<unknown>;

/**
 * What this client needs to reach the platform.
 *
 * An alias of {@link PlatformEndpoint}: the four platform clients take exactly the
 * same credential pair, which is why one `resolvePlatformQueue()` result is already
 * handed to three of them. The name is kept because it is what the call sites read.
 */
export type PlatformStorageOptions = PlatformEndpoint;

/**
 * Make one storage call.
 *
 * @internal
 */
export async function callPlatformStorage(
  opts: PlatformStorageOptions,
  method: string,
  args: readonly unknown[],
): Promise<unknown> {
  const text = await platformPost(opts, {
    route: PLATFORM_ROUTES.workflowStorage,
    label: `storage ${method}`,
    timeoutMs: STORAGE_TIMEOUT_MS,
    // Encoded with the DevKit's own envelope: a run's `input`/`output` are
    // `Uint8Array` at `specVersion >= 2` and `JSON.stringify` turns one into an
    // index map without erroring.
    body: encodeStorageJson({ method, args }),
    // The status is in the message because it is what tells a reader whether to
    // look at this guest or at the platform: a 400 is a call this code built
    // wrongly, a 404 is a run this agent does not own, a 501 is a deployment with
    // no run storage, and a 503 is worth retrying. This route ALWAYS builds its
    // own error rather than falling through to the shared one, because the 404
    // has to reach its caller as the DevKit's own class — see below.
    errorFor: (status, detail) => storageFailure(method, status, detail, args),
  });
  const body = decodeStorageJson(text);
  // `ok` is the discriminator, and `"result" in body` was the bug it replaces.
  // JSON.stringify DROPS an undefined value, so a VOID method — `writeToStream`,
  // which is what every `report()` line goes through — encoded as `{}` and
  // tripped that check on a call the platform had just completed successfully.
  // The run survived (the error is caught a layer up) and its whole narration
  // was silently lost, so `<WorkflowProgress>` stayed empty on every template
  // that narrates, with one `storage writeToStream answered 200 without a
  // result` per line in the guest's log and nothing at all on the page.
  //
  // A key that survives JSON is the only kind that can tell "void" from
  // "malformed", which is what the check is FOR: an empty or truncated body
  // still fails it, and `body.result` is still `undefined` for a void call.
  if (!(isRecord(body) && body.ok === true)) {
    // A 200 the contract does not cover. Throwing means the step retries; returning
    // undefined would look like "no such run" to every caller.
    throw new Error(`storage ${method} answered 200 without a result`);
  }
  return body.result;
}

/**
 * A storage call the platform refused, in the vocabulary its CALLER speaks.
 *
 * A 404 from this route means exactly one thing — the run named in the call is
 * not visible to this agent, whether because it never existed or because it is
 * somebody else's (`workflow-storage-handler.ts` argues why those must be the
 * same answer). The DevKit already has a name for that, and its own runtime and
 * ours already translate it correctly everywhere: `getRun` answers `undefined`,
 * `cancel` answers `false`, `wakeUp` answers `0`. A plain `Error` matched none of
 * those, so it propagated to the workflow API as a 500 — and `readRun`'s
 * `if (!run) 404` branch, which is the right answer, was unreachable.
 *
 * Measured before and after against a deployed agent: `GET`, `DELETE` and `wake`
 * on a well-formed run id nobody had ever issued all answered
 * `{"error":"Internal server error"}`; all three answer 404 now.
 *
 * `WorkflowRunNotFoundError.is` is a NAME check rather than an `instanceof`,
 * which is what makes throwing their class safe here: a guest holds two copies
 * of this code (the harness bundles one, the agent's bundle carries another) and
 * a prototype identity does not survive that seam. Every other status stays a
 * plain error carrying the status, because for those the status IS the finding.
 */
function storageFailure(
  method: string,
  status: number,
  body: string,
  args: readonly unknown[],
): Error {
  const detail = `storage ${method} answered HTTP ${status}: ${body.slice(0, 500)}`;
  // A PERMANENT refusal, in the DevKit's own vocabulary — see
  // `workflow-storage-status.ts` for the taxonomy and for why the platform must
  // not answer one of these 503. Checked before the 404 arm because the two are
  // the same kind of translation and only the subject differs; a plain `Error`
  // here would be retried by a runtime that knows how to stop.
  const permanent = storageErrorForStatus(status, detail);
  if (permanent) return permanent;
  if (status !== 404) return new Error(detail);
  // Their constructor takes the RUN ID and formats it into the message, so it is
  // worth passing the real one: every run-scoped method on this surface takes it
  // first (`STORAGE_SCOPES`'s `run-arg` at index 0), and the ones that do not are
  // named by their method instead rather than by a lie.
  const subject = typeof args[0] === "string" && args[0] !== "" ? args[0] : method;
  const notFound = new WorkflowRunNotFoundError(subject);
  notFound.message = `${notFound.message} — ${detail}`;
  return notFound;
}

/**
 * The DevKit's `Storage`, over HTTP.
 *
 * Typed structurally rather than as their `Storage`, which this package does not
 * import — `@workflow/world` is a transitive dependency it does not declare. The
 * composition site spreads this onto a world that already has the type, which is
 * where a mismatch would surface.
 *
 * @internal
 */
export function createPlatformStorage(opts: PlatformStorageOptions): {
  runs: { get: StorageFn; list: StorageFn };
  steps: { get: StorageFn; list: StorageFn };
  events: { create: StorageFn; get: StorageFn; list: StorageFn; listByCorrelationId: StorageFn };
  hooks: { get: StorageFn; getByToken: StorageFn; list: StorageFn };
} {
  const call = calling(opts);
  // Spelled out rather than generated from a list of names, because this IS the
  // surface: the DevKit's runtime reaches these by name inside a replay, so a
  // missing one is a `TypeError` several layers from here, and a `Record<string,
  // …>` would make every one of them possibly-undefined to its callers.
  return {
    runs: { get: call("runs.get"), list: call("runs.list") },
    steps: { get: call("steps.get"), list: call("steps.list") },
    events: {
      create: call("events.create"),
      get: call("events.get"),
      list: call("events.list"),
      listByCorrelationId: call("events.listByCorrelationId"),
    },
    hooks: {
      get: call("hooks.get"),
      getByToken: call("hooks.getByToken"),
      list: call("hooks.list"),
    },
  };
}

/**
 * The DevKit's `Streamer`, over the same route — minus `readFromStream`.
 *
 * `readFromStream` is deliberately absent. It returns a LIVE
 * `ReadableStream<Uint8Array>` that waits for chunks as they arrive, which is a
 * long-lived streaming response rather than one request and one reply — a different
 * HTTP shape, and its own increment. A composition that needs it takes it from
 * elsewhere; one that spreads only this gets a world whose live reads are absent
 * rather than broken, which is the honest failure.
 *
 * `streamFlushIntervalMs` is a NUMBER on their interface, not a method: it says how
 * long to buffer chunks before flushing. Their own doc says the 10 ms default "is
 * appropriate for HTTP-based backends where each flush is a network round-trip",
 * which is exactly what this is — so it is left at their default by not being set.
 *
 * @internal
 */
export function createPlatformStreamer(opts: PlatformStorageOptions): {
  writeToStream: StorageFn;
  writeToStreamMulti: StorageFn;
  closeStream: StorageFn;
  listStreamsByRunId: StorageFn;
  getStreamChunks: StorageFn;
  getStreamInfo: StorageFn;
} {
  const call = calling(opts);
  return {
    writeToStream: call("streamer.writeToStream"),
    writeToStreamMulti: call("streamer.writeToStreamMulti"),
    closeStream: call("streamer.closeStream"),
    // Entropy-based rule, no allow-list, and the identifier is theirs to name.
    // biome-ignore lint/security/noSecrets: the DevKit's method name, not a secret.
    listStreamsByRunId: call("streamer.listStreamsByRunId"),
    getStreamChunks: call("streamer.getStreamChunks"),
    getStreamInfo: call("streamer.getStreamInfo"),
  };
}

/**
 * `readFromStream`, which is a streaming response rather than an RPC call.
 *
 * Their signature returns a `ReadableStream<Uint8Array>` that yields chunks as they
 * arrive, so the HTTP body IS the stream: `res.body` is already exactly that type,
 * and handing it over directly is both the simplest implementation and the only one
 * that stays live — buffering it into an array would defeat the point.
 *
 * ## The response is BOUNDED, and a reconnect is the contract
 *
 * The platform ends a read after its own cap (a stream whose run died never sees an
 * EOF, and a connection held forever is the alternative). So a stream that closes
 * without the run having finished is not an error: the caller reads what arrived and
 * asks again with `startIndex`, which is what that parameter is for.
 *
 * This does NOT reconnect on its own. The DevKit's consumers treat the stream
 * ending as the stream ending, and a client that silently resumed would turn a
 * finished stream and a truncated one into the same thing.
 *
 * @internal
 */
export function createPlatformStreamReader(
  opts: PlatformStorageOptions,
): (name: string, startIndex?: number) => Promise<ReadableStream<Uint8Array>> {
  return async (name: string, startIndex?: number) => {
    // `egressFetch`, never the global — see `_egress-fetch.ts`. This one is the
    // WORST case for the HTTP/2 default it avoids: the read is meant to stay open,
    // so on a multiplexed connection a live event stream sits on the same
    // flow-control window as the upload broker's byte operations, and a reset takes
    // both. Which is what production showed — `Workflow run event read failed
    // { error: 'fetch failed' }` interleaved with the claim's 500s, same instant.
    const fetchFn = opts.fetch ?? egressFetch;
    const url = new URL(platformUrl(opts.base, PLATFORM_ROUTES.workflowStream));
    url.searchParams.set("name", name);
    // A NEGATIVE index is legal and load-bearing: their doc says it starts that many
    // chunks before the current end, which is how a reconnecting reader asks for
    // "the last few".
    if (startIndex !== undefined) url.searchParams.set("startIndex", String(startIndex));

    // NOT wrapped in a timeout, unlike every other call here. This response is meant
    // to stay open — a deadline would cut a healthy live read at its own interval,
    // and the platform already bounds it.
    const res = await fetchFn(url, { headers: platformBearer(opts.token) });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`stream read answered HTTP ${res.status}: ${detail.slice(0, 500)}`);
    }
    if (!res.body) {
      // A 200 with no body is a platform that changed its contract. An empty stream
      // would look like a stream that had already finished.
      throw new Error("stream read answered 200 with no body");
    }
    return res.body;
  };
}

/** One method name to a function that calls it. */
function calling(opts: PlatformStorageOptions): (method: string) => StorageFn {
  return (method: string) =>
    (...args: unknown[]) =>
      callPlatformStorage(opts, method, args);
}
