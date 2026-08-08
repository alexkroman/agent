// Copyright 2025 the AAI authors. MIT license.
/// <reference path="../bogon.d.ts" />
/**
 * SSRF protection.
 *
 * Validates URLs against private/reserved IP ranges and handles redirects
 * safely by re-validating each redirect target.
 *
 * Lives in the SDK (not `aai-server`) so both the platform's guest-fetch proxy
 * and the SDK's own network builtins resolve the same implementation — the
 * builtins default to it, rather than each caller having to remember to inject
 * an SSRF-safe fetch.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import bogon from "bogon";
import pTimeout from "p-timeout";
import { Agent, fetch as undiciFetch } from "undici";

const BLOCKED_TLDS = [".internal", ".local", ".localhost"];
/**
 * Named metadata endpoints, kept as belt-and-braces beside {@link
 * BLOCKED_TLDS}. Note both current entries end in `.internal`, so the TLD
 * rule already catches them — mutation testing flags emptying this Set as
 * surviving, and that is accurate rather than a missing test. It earns its
 * place only for a future metadata hostname that does NOT sit under a blocked
 * TLD; add such a host here, and a spec with it, rather than assuming this
 * list is what is doing the work today.
 */
const BLOCKED_HOSTS = new Set(["metadata.google.internal", "instance-data.ec2.internal"]);

/** Thrown when a URL is rejected by SSRF policy (vs. an incidental failure). */
class SsrfBlockedError extends Error {}

/**
 * The `fetch` every pinned request must go through — deliberately NOT
 * `globalThis.fetch`, and NOT SSRF-checked itself.
 *
 * `pinnedDispatcher` builds an `Agent` from this package's own `undici`
 * dependency; Node's global `fetch` is backed by a different bundled undici
 * copy whose dispatch-handler interface may not match, so the two must come
 * from the same package. Exported for `ssrf-dispatcher.test.ts`, which guards
 * the pairing.
 *
 * @internal
 */
export const pinnedFetch = undiciFetch as unknown as typeof globalThis.fetch;

/** @internal */
export function isPrivateIp(ip: string): boolean {
  return bogon(ip);
}

/**
 * Literal IPv4/IPv6 address? Callers strip the URL's `[...]` brackets first.
 * Near-miss strings the old hand-rolled regex accepted (`999.1.1.1`, stray
 * colons) now fall through to the DNS path, where resolution fails closed.
 */
function isLiteralIp(hostname: string): boolean {
  return isIP(hostname) !== 0;
}

/**
 * The DNS resolution this module screens. Injectable so the rebinding defense
 * below can be tested for what it DOES rather than for what the test host's
 * resolver happens to answer.
 *
 * @internal
 */
export type DnsLookup = (hostname: string) => Promise<{ address: string }>;

/**
 * Single-pass validation: checks hostname rules, resolves DNS if needed,
 * validates the resolved IP, and returns the resolved IP for pinning.
 * Returns null if the hostname is already a literal IP (already validated).
 *
 * `lookupFn` exists for tests, like `ssrfSafeFetch`'s `fetchFn` — production
 * callers leave it unset. Without it the one branch that IS the DNS-rebinding
 * defense ("hostname resolves to a private address") had no deterministic
 * test: the only way to control `node:dns/promises` was a module mock, which
 * had to live in a separate file so it would not leak into the rest of the
 * suite, and the decimal-encoded-localhost spec instead hedged across both
 * outcomes and so could not fail at all.
 *
 * @internal
 */
export async function resolveAndAssertPublic(
  url: string,
  lookupFn: DnsLookup = lookup,
): Promise<string | null> {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError(`Blocked request with disallowed protocol: ${parsed.protocol}`);
  }
  if (BLOCKED_HOSTS.has(hostname) || BLOCKED_TLDS.some((tld) => hostname.endsWith(tld))) {
    throw new SsrfBlockedError(`Blocked request to reserved hostname: ${hostname}`);
  }
  if (isLiteralIp(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new SsrfBlockedError(`Blocked request to private address: ${hostname}`);
    }
    return null;
  }
  // Hostname is not a literal IP — resolve DNS and validate the result
  try {
    const { address } = await pTimeout(lookupFn(hostname), {
      milliseconds: 2000,
      message: "DNS lookup timed out",
    });
    if (isPrivateIp(address)) {
      throw new SsrfBlockedError(
        `Blocked request: ${hostname} resolves to private address ${address}`,
      );
    }
    return address;
  } catch (err) {
    if (err instanceof SsrfBlockedError) throw err;
    throw new SsrfBlockedError(`Blocked request: DNS resolution failed for ${hostname}`, {
      cause: err,
    });
  }
}

const MAX_REDIRECTS = 5;

/**
 * The dispatcher type `fetch` accepts. `@types/node` declares
 * `RequestInit.dispatcher` via its own bundled copy of `undici-types`, which is
 * a different copy of the declarations from the `undici` package the Agent is
 * constructed with — structurally the same object, nominally incompatible. The
 * cast in `pinnedDispatcher` bridges exactly that mismatch.
 */
type FetchDispatcher = NonNullable<RequestInit["dispatcher"]>;

/**
 * Pin the connection to an already-validated IP without rewriting the URL.
 *
 * Rewriting the URL's hostname to the resolved IP (the previous approach)
 * pinned DNS but broke TLS: SNI and certificate verification use the URL
 * hostname, so every `https://` request failed with
 * "Hostname/IP does not match certificate's altnames". Overriding the
 * `Host` header does not help — Node validates against the URL, not the
 * header.
 *
 * Instead we keep the original URL (correct SNI + cert validation) and
 * override DNS resolution for this request only, so the socket can only
 * ever connect to the IP we already checked against the bogon list. That
 * closes the TOCTOU DNS-rebinding window that pinning existed to close.
 *
 * Injected fetch implementations that aren't undici-backed (test doubles)
 * simply ignore the dispatcher.
 */
/**
 * The pin itself: a `lookup` that ignores the hostname and answers with the
 * address already screened. Split out of {@link pinnedDispatcher} because it
 * is the whole security content of that function and was untestable inside
 * it — `pinnedDispatcher` is reached only through a DNS-resolved hostname, so
 * every mutation of the address and family survived the suite while
 * `ssrf-dispatcher.test.ts` exercised an Agent it built itself.
 *
 * The family is derived rather than passed: undici rejects a v4 address
 * announced as family 6 (and vice versa) at connect time, which surfaces as
 * an opaque fetch failure rather than as anything naming DNS.
 *
 * @internal
 */
export function pinnedLookup(resolvedIp: string) {
  const family = resolvedIp.includes(":") ? 6 : 4;
  return (
    _hostname: string,
    _options: unknown,
    callback: (err: Error | null, addresses: { address: string; family: number }[]) => void,
  ): void => {
    callback(null, [{ address: resolvedIp, family }]);
  };
}

function pinnedDispatcher(resolvedIp: string): FetchDispatcher {
  const agent = new Agent({
    connect: {
      lookup: pinnedLookup(resolvedIp),
    },
    // One Agent is created per request, so it must not hold sockets open
    // after the response body is consumed. We deliberately do NOT call
    // `close()` — the returned Response still owns its body stream — and
    // instead let idle sockets lapse promptly and the Agent be collected.
    keepAliveTimeout: 1000,
    keepAliveMaxTimeout: 1000,
  });
  return agent as unknown as FetchDispatcher;
}

/** Headers that must never be replayed to a different origin across a redirect. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/**
 * The lower-level SSRF-guarded fetch engine — NOT an alias of `safeFetch`.
 * Takes a mandatory `fetchFn` and drives the validate → pin → follow-redirects
 * loop with it; `safeFetch` is this engine curried with `pinnedFetch` and is
 * what callers should use.
 *
 * @internal
 */
export async function ssrfSafeFetch(
  url: string,
  init: RequestInit,
  fetchFn: typeof globalThis.fetch,
): Promise<Response> {
  const originalOrigin = new URL(url).origin;
  let resolvedIp = await resolveAndAssertPublic(url);
  let currentUrl = url;
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const headers = new Headers(init.headers);
    // Drop credentials once the request has left its original origin so an
    // open redirect on an allowed host can't exfiltrate the agent's token.
    if (new URL(currentUrl).origin !== originalOrigin) {
      for (const h of CREDENTIAL_HEADERS) headers.delete(h);
    }
    const reqInit: RequestInit = { ...init, headers, redirect: "manual" };
    // resolvedIp is null when the URL already names a literal IP — it was
    // validated directly, so there is no DNS step to pin.
    if (resolvedIp !== null) reqInit.dispatcher = pinnedDispatcher(resolvedIp);
    const resp = await fetchFn(currentUrl, reqInit);
    if (resp.status < 300 || resp.status >= 400) return resp;
    const location = resp.headers.get("location");
    if (!location) return resp;
    // Release the redirect response's socket before following the hop.
    await resp.body?.cancel().catch(() => undefined);
    currentUrl = new URL(location, currentUrl).href;
    resolvedIp = await resolveAndAssertPublic(currentUrl);
  }
  throw new Error("Too many redirects");
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * `globalThis.fetch` wrapped in SSRF validation — the default for every
 * network builtin. Private/reserved addresses, non-HTTP(S) protocols, and
 * reserved hostnames are rejected, each redirect hop is re-validated, and
 * credentials are stripped when a redirect leaves the original origin.
 */
export const safeFetch: typeof globalThis.fetch = (input, init) =>
  ssrfSafeFetch(requestUrl(input), init ?? {}, pinnedFetch);

/**
 * Env flag a SPAWNER sets when the runtime is wrapped in a real container.
 * Declared by the spawner, never inferred by the guest: "am I a guest" and
 * "am I contained" are different questions, and the subprocess backend runs
 * a guest with no container around it at all.
 */
export const CONTAINED_ENV = "AAI_SANDBOX_CONTAINED";

/**
 * Internal selector: returns the fetch the network builtins should use — a
 * function that *picks* a fetch, not a fetch itself.
 *
 * One rule: **screen only when there is no container around us.**
 *
 * Inside a real sandbox the screen protects nothing a tenant cannot bypass in
 * one line — their own tool code has open egress by design, so a guard on
 * `visit_webpage` constrains the model, not the author. The container is the
 * boundary, it holds no platform credentials, and `ctx.db` goes through host
 * RPC.
 *
 * Everywhere else the host IS someone's machine — `aai dev` runs these same
 * builtins in the developer's own process, where a model-controlled URL can
 * reach localhost, the LAN, or cloud metadata. That is where the screen earns
 * its keep, so that is where it stays.
 *
 * @internal
 */
export function builtinFetch(env: NodeJS.ProcessEnv = process.env): typeof globalThis.fetch {
  return env[CONTAINED_ENV] === "1" ? pinnedFetch : safeFetch;
}
