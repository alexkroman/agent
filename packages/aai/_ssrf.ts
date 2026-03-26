// Copyright 2025 the AAI authors. MIT license.

/**
 * SSRF protection for built-in network tools.
 *
 * Validates URLs against private/reserved IP ranges and handles redirects
 * safely by re-validating each redirect target. Mirrors the logic in
 * aai-server/_net.ts but lives in the SDK package so self-hosted
 * deployments also get protection.
 */

const PRIVATE_RANGES: readonly [string, number][] = [
  ["0", 8],
  ["10", 8],
  ["100.64", 10],
  ["127", 8],
  ["169.254", 16],
  ["172.16", 12],
  ["192.0.0", 24],
  ["192.168", 16],
  ["198.18", 15],
  ["224", 4],
  ["240", 4],
];

function ipToInt(ip: string): number {
  const [a = 0, b = 0, c = 0, d = 0] = ip.split(".").map(Number);
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function isPrivateIpv4(ip: string): boolean {
  const n = ipToInt(ip);
  for (const [prefix, bits] of PRIVATE_RANGES) {
    const parts = prefix.split(".");
    while (parts.length < 4) parts.push("0");
    const net = ipToInt(parts.join("."));
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) === (net & mask)) return true;
  }
  return false;
}

export function assertPublicUrl(url: string): void {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  // Extract IPv4 from IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  const mappedDotted = hostname.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  const mappedHex = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  let effective = hostname;
  if (mappedDotted) {
    effective = mappedDotted[1] as string;
  } else if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1] as string, 16);
    const lo = Number.parseInt(mappedHex[2] as string, 16);
    effective = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  // Check for IPv4 private ranges
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(effective) && isPrivateIpv4(effective)) {
    throw new Error(`Blocked request to private address: ${hostname}`);
  }

  // Block well-known private hostnames and IPv6 loopback
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower === "::1" ||
    lower === "::" ||
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
