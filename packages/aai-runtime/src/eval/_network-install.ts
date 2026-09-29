// Copyright 2026 the AAI authors. MIT license.
/**
 * Putting an {@link EvalNetwork} under a `describeEval` suite: one dispatcher
 * for all three fetches, installed for the whole suite, pointed at one case's
 * network at a time.
 *
 * ## Why the SUITE, and not each case
 *
 * A case's world is opened before its body and closed after it, and that is
 * the wrong lifetime for a global `fetch`. `onSessionEnd` is fire-and-forget
 * by contract, and the eval session waits for it only so long (10 seconds), so
 * a hook that writes the call's outcome can still run after the case closed
 * its session — and a `fetch` restored by then goes to the REAL network. A downstream suite hit exactly that and stubbed the global for the
 * whole file instead. So the dispatcher is installed in the suite's
 * `beforeAll` and restored in its `afterAll`; between cases (and after the
 * last one) there is no current network and a request is REFUSED — logged to
 * the network of the case that just ended, where it belongs.
 *
 * ## The three fetches
 *
 * - the global `fetch`, which custom tools call and which `stepFetch` falls
 *   back to;
 * - the session's `fetch` option, which the builtins take;
 * - the published step fetch, re-published per case because an eval workflow
 *   engine unpublishes the slot when it closes.
 *
 * The live model's hosts ({@link modelHosts}) go straight to the fetch this
 * replaced, and are not logged: that traffic is the harness's.
 *
 * @module
 */

import { publishStepFetch, type StepFetch } from "@alexkroman1/aai/host-internal";
import type { EvalMode } from "./_announce.ts";
import { modelHosts } from "./_model-hosts.ts";
import type { EvalCaseOptions } from "./describe.ts";
import {
  type EvalNetwork,
  evalPassthroughFetch,
  keyMatches,
  setEvalPassthroughFetch,
} from "./network.ts";

/** What `describeEval` and each case may pass as `network`. */
export type EvalNetworkSource = EvalNetwork | (() => EvalNetwork);

/** The suite's dispatcher: installed once, aimed at one case at a time. */
export type SuiteNetwork = {
  /** Swap the global in. The suite's `beforeAll`. */
  install(): void;
  /** Put the global back. The suite's `afterAll`. */
  restore(): void;
  /**
   * Aim the dispatcher at a case: a fresh network from a factory, or an
   * instance with its log reset — per case and per repeat. Returns the
   * network, and the fetch the session's builtins take.
   */
  begin(source: EvalNetworkSource): { network: EvalNetwork; fetch: typeof globalThis.fetch };
  /** The case is over; late requests are refused into its log. */
  end(): void;
};

/**
 * Build a suite's dispatcher. `models` are the descriptors whose hosts pass
 * through in LIVE mode only — a scripted run's model makes no request, so a
 * request to a provider host there is a tool's, and is routed or refused like
 * any other.
 */
export function suiteNetwork(
  mode: EvalMode,
  models: Parameters<typeof modelHosts>[0],
): SuiteNetwork {
  const passed = mode === "live" ? modelHosts(models) : [];
  let current: EvalNetwork | undefined;
  let last: EvalNetwork | undefined;
  let replaced: typeof globalThis.fetch | undefined;

  const dispatch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (passed.some((host) => keyMatches(host, url))) return evalPassthroughFetch()(input, init);
    const network = current ?? last;
    if (network !== undefined) return network.fetch(input, init);
    throw new TypeError(
      `eval network: refused ${url.href} — no eval case is running, so nothing may reach the network.`,
    );
  };
  const fetchFn = dispatch as typeof globalThis.fetch;

  return {
    install() {
      // Read BEFORE the swap, through the one accessor that says why the
      // ambient fetch is the right one to pass the model's traffic to.
      replaced = evalPassthroughFetch();
      setEvalPassthroughFetch(replaced);
      globalThis.fetch = fetchFn;
    },
    restore() {
      if (replaced !== undefined) globalThis.fetch = replaced;
      setEvalPassthroughFetch(undefined);
      publishStepFetch(undefined);
      replaced = undefined;
    },
    begin(source) {
      const network = typeof source === "function" ? source() : source;
      if (typeof source !== "function") network.reset();
      current = network;
      last = network;
      publishStepFetch(stepFetchOver(fetchFn));
      return { network, fetch: fetchFn };
    },
    end() {
      current = undefined;
    },
  };
}

/** The dispatcher as a {@link StepFetch}: same request, a streamed body read whole. */
export function stepFetchOver(fetchFn: typeof globalThis.fetch): StepFetch {
  return async (url, init) => {
    const body = init?.body;
    let payload: Uint8Array | string | undefined;
    if (body === undefined || typeof body === "string" || body instanceof Uint8Array) {
      payload = body;
    } else {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      payload = Buffer.concat(chunks);
    }
    const request: RequestInit = {};
    if (init?.method !== undefined) request.method = init.method;
    if (init?.headers !== undefined) request.headers = init.headers;
    if (init?.signal !== undefined) request.signal = init.signal;
    // Bytes COPIED into a fresh `ArrayBuffer`: a view over a shared or
    // resizable buffer is not a `BodyInit` under every lib a consumer compiles
    // this with (`aai-templates`' tsconfig reddened on exactly that).
    if (payload !== undefined) {
      request.body = typeof payload === "string" ? payload : new Uint8Array(payload);
    }
    return await fetchFn(url, request);
  };
}

/** Is a network in play anywhere in this suite — its own options, or any case's? */
export function wantsNetwork(
  suite: EvalNetworkSource | undefined,
  cases: readonly (EvalCaseOptions | undefined)[],
): boolean {
  return suite !== undefined || cases.some((c) => c?.network !== undefined);
}
