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
import pTimeout from "p-timeout";
import { decodeTypedJson, encodeTypedJson } from "./workflow-typed-json.ts";

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

export type PlatformStorageOptions = {
  /**
   * The agent's public base URL, slug included — `AAI_PUBLIC_BASE_URL`.
   *
   * The guest does not COMPOSE this, so it cannot name another app's prefix even in
   * principle; the platform derives the tenant from the slug in the path.
   */
  base: string;
  /** This sandbox's bearer — `AAI_GUEST_TOKEN`. */
  token: string;
  /** Test seam — production uses the global. */
  fetch?: typeof globalThis.fetch | undefined;
};

/** `<base>/workflow-storage`, tolerating a trailing slash on the base. */
function storageUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/workflow-storage`;
}

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
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const url = storageUrl(opts.base);
  const res = await pTimeout(
    fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.token}`,
        "content-type": "application/json",
      },
      body: encodeTypedJson({ method, args }),
    }),
    { milliseconds: STORAGE_TIMEOUT_MS, message: `storage ${method} timed out` },
  );
  const text = await res.text();
  if (!res.ok) {
    // The status is in the message because it is what tells a reader whether to
    // look at this guest or at the platform: a 400 is a call this code built
    // wrongly, a 404 is a run this agent does not own, a 501 is a deployment with
    // no run storage, and a 503 is worth retrying.
    throw new Error(`storage ${method} answered HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const body = decodeTypedJson(text);
  if (!(isRecord(body) && "result" in body)) {
    // A 200 the contract does not cover. Throwing means the step retries; returning
    // undefined would look like "no such run" to every caller.
    throw new Error(`storage ${method} answered 200 without a result`);
  }
  return body.result;
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
  const call =
    (method: string): StorageFn =>
    (...args: unknown[]) =>
      callPlatformStorage(opts, method, args);

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
