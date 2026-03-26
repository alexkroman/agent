// Copyright 2025 the AAI authors. MIT license.

/**
 * SSRF protection for AAI network tools.
 *
 * Validates URLs against private/reserved IP ranges and handles redirects
 * safely by re-validating each redirect target. Used by both the SDK
 * (self-hosted built-in tools) and the platform server.
 */

import { BlockList } from "node:net";

const privateBlocks = new BlockList();

// IPv4 private/reserved ranges (RFC 1918, RFC 6598, etc.)
for (const [prefix, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  privateBlocks.addSubnet(prefix, bits, "ipv4");
}

// IPv6 private/reserved ranges
for (const [prefix, bits] of [
  ["::1", 128],
  ["::", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  privateBlocks.addSubnet(prefix, bits, "ipv6");
}

export function isPrivateIp(ip: string): boolean {
  const type = ip.includes(":") ? "ipv6" : "ipv4";
  return privateBlocks.check(ip, type);
}

/**
 * Detect IPv4-mapped IPv6 addresses and extract the embedded IPv4.
 * Handles both dotted form (`::ffff:127.0.0.1`) and hex form (`::ffff:7f00:1`).
 */
function extractMappedIp(ip: string): string {
  // Dotted form: ::ffff:127.0.0.1
  const mappedDotted = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mappedDotted) return mappedDotted[1] as string;

  // Hex form: ::ffff:7f00:1
  const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1] as string, 16);
    const lo = Number.parseInt(mappedHex[2] as string, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  return ip;
}

/**
 * SSRF guard: block requests to private/reserved IPs and well-known
 * internal hostnames.
 */
export function assertPublicUrl(url: string): void {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const effective = extractMappedIp(hostname);

  if (isPrivateIp(hostname) || isPrivateIp(effective)) {
    throw new Error(`Blocked request to private address: ${hostname}`);
  }

  // Block localhost, .local (mDNS), and common cloud metadata hostnames
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal") ||
    lower === "metadata.google.internal" ||
    lower === "169.254.169.254"
  ) {
    throw new Error(`Blocked request to private address: ${hostname}`);
  }

  // Only allow http/https schemes
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked request with disallowed protocol: ${parsed.protocol}`);
  }
}

/** Maximum number of redirects to follow manually. */
const MAX_REDIRECTS = 5;

/**
 * Fetch with SSRF-safe redirect handling: validates each redirect URL
 * against private/reserved IP ranges before following.
 */
export async function ssrfSafeFetch(
  url: string,
  init: RequestInit,
  fetchFn: typeof globalThis.fetch,
): Promise<Response> {
  assertPublicUrl(url);
  let currentUrl = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const resp = await fetchFn(currentUrl, { ...init, redirect: "manual" });
    if (resp.status < 300 || resp.status >= 400) return resp;
    const location = resp.headers.get("location");
    if (!location) return resp;
    currentUrl = new URL(location, currentUrl).href;
    assertPublicUrl(currentUrl);
  }
  throw new Error("Too many redirects");
}
