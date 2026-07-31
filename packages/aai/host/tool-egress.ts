// Copyright 2026 the AAI authors. MIT license.
/**
 * `allowedHosts` enforcement for **self-hosted** tool code (`aai dev`).
 *
 * On the platform, an agent's own tool code runs in a sandboxed Deno guest with no
 * network device: its `fetch` is RPC-proxied to the host, which rejects any
 * hostname outside the agent's `allowedHosts`. Self-hosted runs have no
 * sandbox, so tool code reached the real `globalThis.fetch` unchecked — an
 * undeclared host worked all through development and only failed after
 * deploy, at which point the error is somebody else's production incident.
 *
 * This closes that gap by holding the policy in an `AsyncLocalStorage` scope
 * entered around each **custom** tool call and consulting it from a wrapped
 * global `fetch`. The wrapper is inert outside a tool call, so the host's own
 * traffic — LLM streams, STT/TTS sockets, the network builtins — is untouched:
 *
 * - **Built-in tools are exempt on purpose.** `fetch_json`, `visit_webpage`,
 *   `get_page_design`, and `web_search` execute host-side in production too (see
 *   `SANDBOX_ONLY_BUILTINS`), where `allowedHosts` never applies to them.
 *   Subjecting them to it here would invent a restriction production doesn't
 *   have — the opposite of the parity this module exists for.
 * - **`ctx.db` / `ctx.vector` are exempt** via {@link exemptFromToolEgress}.
 *   In the guest these are their own RPC methods, not `fetch`, so a tool can
 *   use them without declaring any host. A BYO `pinecone` provider talks
 *   HTTP from inside the tool's async scope, and without the exemption its
 *   storage endpoint would need listing in `allowedHosts` — a restriction
 *   production does not impose.
 *
 * Scoping is per async context rather than per process because the host is
 * multi-session: one agent's tool call must not relax or tighten what another
 * concurrent session may reach.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  capResponseBody,
  checkToolFetch,
  performToolFetch,
  TOOL_FETCH_TIMEOUT_MS,
} from "./guest-fetch-policy.ts";

type EgressScope = {
  allowedHosts: readonly string[];
  /** Fetches in flight for this scope, for the shared concurrency cap. */
  active: { count: number };
};

const egressScope = new AsyncLocalStorage<EgressScope>();

/** Marks an already-wrapped `fetch`, so installing twice is a no-op. */
const GUARD_TAG = Symbol.for("aai.toolFetchGuard");

type GuardedFetch = typeof globalThis.fetch & { [GUARD_TAG]?: true };

/** Normalize a `fetch`'s first argument to a URL string plus its body size. */
async function describeRequest(
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
): Promise<{ url: string; bodyBytes: number; init: RequestInit }> {
  const request = new Request(input, init);
  // Buffer the body so its size is known to the policy and still sendable.
  // A bodyless GET short-circuits, which is the overwhelmingly common case.
  if (!request.body) {
    return { url: request.url, bodyBytes: 0, init: requestInit(request) };
  }
  const body = await request.arrayBuffer();
  return {
    url: request.url,
    bodyBytes: body.byteLength,
    init: { ...requestInit(request), body },
  };
}

function requestInit(request: Request): RequestInit {
  return {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    ...(request.signal ? { signal: request.signal } : {}),
  };
}

/**
 * Wrap `globalThis.fetch` so calls made inside a tool-egress scope go through
 * the shared {@link checkToolFetch}/{@link performToolFetch} policy — the same
 * one the platform applies to a guest's proxied fetch.
 *
 * Idempotent, and inert outside a scope: the host's own traffic (LLM streams,
 * STT/TTS sockets, host-side builtins) delegates through unchanged.
 */
export function installToolFetchGuard(): void {
  const current: GuardedFetch = globalThis.fetch;
  if (current[GUARD_TAG]) return;

  const guarded: GuardedFetch = async (input, init) => {
    const scope = egressScope.getStore();
    if (!scope) return current(input, init);

    const { url, bodyBytes, init: normalized } = await describeRequest(input, init);
    const verdict = checkToolFetch({
      url,
      bodyBytes,
      allowedHosts: scope.allowedHosts,
      activeCount: scope.active.count,
    });
    if (!verdict.ok) {
      // A TypeError is what a real `fetch` rejection looks like, so tool code
      // that catches fetch failures behaves the same in both modes.
      throw new TypeError(
        `${verdict.reason} (enforced locally so this matches a deployed agent, ` +
          "where tool code runs sandboxed with no network device)",
      );
    }

    scope.active.count++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      scope.active.count--;
    };
    try {
      // No `fetchFn`: `performToolFetch` must use its own pinned default. Its
      // SSRF screening attaches a DNS-pinning dispatcher built from this
      // package's undici, and only that package's `fetch` accepts it — handing
      // in the host runtime's global (a different undici major) fails every
      // hostname request with a bare `TypeError: fetch failed`.
      //
      // Exiting the scope is still required: a nested fetch `performToolFetch`
      // makes (following an SSRF-checked redirect) must not re-enter this
      // wrapper and double-count concurrency.
      const response = await egressScope.exit(() =>
        performToolFetch(url, normalized, { allowedHosts: scope.allowedHosts }),
      );
      // The slot is held until the response BODY settles, matching the
      // platform, which holds its slot while relaying the body over NDJSON —
      // releasing at headers under-counted streaming reads and made the cap
      // looser in dev than in production. A body the tool never reads settles
      // nothing, so a backstop timer bounds the hold at the fetch timeout;
      // the request itself cannot outlive that (AbortSignal.timeout covers
      // the body read too).
      setTimeout(release, TOOL_FETCH_TIMEOUT_MS).unref?.();
      return capResponseBody(response, release);
    } catch (err) {
      release();
      throw err;
    }
  };
  guarded[GUARD_TAG] = true;
  globalThis.fetch = guarded;
}

/**
 * Run `fn` with the tool-fetch policy enforced on any `fetch` it performs.
 *
 * Pass `active` to share one concurrency counter across calls. The platform's
 * cap is per **agent** (one counter per sandbox fetch handler), so a runtime
 * should thread one per-runtime object here — a fresh counter per tool call
 * would let N concurrent tool calls each open the full budget, a cap that
 * passes in dev and trips in production.
 */
export function runInToolEgress<T>(
  allowedHosts: readonly string[],
  fn: () => T,
  active?: { count: number },
): T {
  return egressScope.run({ allowedHosts, active: active ?? { count: 0 } }, fn);
}

/**
 * Wrap an SDK-provided object (`Db`, `Vector`) so its methods run outside any
 * tool-egress scope — their HTTP traffic is infrastructure the platform serves
 * over RPC, not agent-controlled egress.
 */
export function exemptFromToolEgress<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => egressScope.exit(() => Reflect.apply(value, obj, args));
    },
  });
}
