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
import { Agent } from "undici";
import {
  asDispatcher,
  type FetchDispatcher,
  type PinnedRequestInit,
  pinnedFetch,
} from "./_undici.ts";

/**
 * Re-exported for `ssrf-dispatcher.test.ts`, which guards the fetch/dispatcher
 * pairing, and for `/runtime`, whose barrel has always published it from here.
 * It and the two dispatcher types moved to `_undici.ts` when `step-fetch.ts`
 * became the second caller — see that module for why the bridge exists and why
 * the fetch may not be `globalThis.fetch`.
 *
 * @internal
 */
export { pinnedFetch } from "./_undici.ts";

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

/** @internal */
export function isPrivateIp(ip: string): boolean {
  if (bogon(ip)) return true;
  // `bogon` screens the address as written, which misses an IPv6 address that
  // NAMES an IPv4 destination through a translation prefix — see
  // {@link translatedIpv4}.
  const embedded = translatedIpv4(ip);
  return embedded !== undefined && bogon(embedded);
}

/**
 * The 16 bytes of an IPv6 literal, or `undefined` when it will not parse.
 *
 * Callers reach this only for a string `isIP` has already accepted, so this
 * handles the valid forms rather than validating: hex groups, one `::`
 * compression, an optional trailing dotted quad, and a `%zone` suffix. It
 * exists because Node has no public IPv6-to-bytes API and the prefix checks
 * below cannot be done on the text — `64:ff9b::7f00:1` and
 * `0064:ff9b:0000:0000:0000:0000:127.0.0.1` are the same address.
 */
function ipv6Bytes(ip: string): Uint8Array | undefined {
  const bare = ip.split("%", 1)[0] ?? ip;
  const halves = bare.split("::");
  if (halves.length > 2) return undefined;
  const head = ipv6GroupBytes(halves[0] ?? "");
  const tail = ipv6GroupBytes(halves.length === 2 ? (halves[1] ?? "") : "");
  if (head === undefined || tail === undefined) return undefined;
  const gap = 16 - head.length - tail.length;
  if (halves.length === 2 ? gap < 0 : gap !== 0) return undefined;
  return Uint8Array.from([...head, ...new Array<number>(gap).fill(0), ...tail]);
}

/** One `:`-separated run of IPv6 groups, as bytes. Its own function for the line above's complexity. */
function ipv6GroupBytes(part: string): number[] | undefined {
  if (part === "") return [];
  const out: number[] = [];
  for (const group of part.split(":")) {
    // A trailing dotted quad occupies the last two groups.
    const bytes = group.includes(".") ? dottedQuadBytes(group) : hextetBytes(group);
    if (bytes === undefined) return undefined;
    out.push(...bytes);
  }
  return out;
}

/** `a.b.c.d` as four bytes. */
function dottedQuadBytes(group: string): number[] | undefined {
  const octets = group.split(".");
  if (octets.length !== 4) return undefined;
  const bytes = octets.map(Number);
  return bytes.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ? bytes : undefined;
}

/** One hex group as two bytes. */
function hextetBytes(group: string): number[] | undefined {
  const value = Number.parseInt(group, 16);
  if (!Number.isInteger(value) || value < 0 || value > 0xff_ff) return undefined;
  return [(value >> 8) & 0xff, value & 0xff];
}

/** The NAT64 well-known prefix, `64:ff9b::/96` (RFC 6052). */
const NAT64_WELL_KNOWN = [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];
/** The 6to4 prefix, `2002::/16` (RFC 3056). */
const SIX_TO_FOUR = [0x20, 0x02];

/**
 * The IPv4 address an IPv6 TRANSLATION address carries, or `undefined`.
 *
 * `bogon` catches the IPv4-mapped (`::ffff:0:0/96`) and IPv4-compatible
 * (`::/96`) forms, and the suite above pins both. It does not catch the two
 * prefixes that name an IPv4 destination for a translator to reach: measured,
 * `64:ff9b::a9fe:a9fe` and `2002:a9fe:a9fe::` — the cloud metadata endpoint —
 * both passed as ordinary global unicast.
 *
 * **The embedded address is screened, never the prefix**, because NAT64 is how
 * an IPv6-only host reaches the IPv4 internet at all: refusing `64:ff9b::/96`
 * outright would refuse every IPv4 destination on such a network. So
 * `64:ff9b::808:808` (8.8.8.8) stays allowed and `64:ff9b::7f00:1` (127.0.0.1)
 * does not.
 *
 * Both prefixes are exclusively assigned to their mechanism, so no legitimate
 * global-unicast address falls in either. Teredo (`2001::/32`) is deliberately
 * absent: it tunnels IPv6, so its embedded IPv4 names a relay and a client's
 * NAT, not a destination the caller chose — it is not this class of bypass.
 */
function translatedIpv4(ip: string): string | undefined {
  if (!ip.includes(":")) return undefined;
  const bytes = ipv6Bytes(ip);
  if (bytes === undefined) return undefined;
  const at = (prefix: readonly number[]): boolean => prefix.every((b, i) => bytes[i] === b);
  const dotted = (start: number): string => Array.from(bytes.subarray(start, start + 4)).join(".");
  if (at(NAT64_WELL_KNOWN)) return dotted(12);
  if (at(SIX_TO_FOUR)) return dotted(2);
  return undefined;
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
  // The bridge, and why one is needed, live in `_undici.ts`.
  return asDispatcher(agent);
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
    const reqInit: PinnedRequestInit = { ...init, headers, redirect: "manual" };
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
