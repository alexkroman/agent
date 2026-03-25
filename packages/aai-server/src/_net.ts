// Copyright 2025 the AAI authors. MIT license.

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
 * Detect IPv4-mapped IPv6 addresses (e.g. `::ffff:127.0.0.1`) and extract
 * the embedded IPv4 for a proper private-IP check.
 */
function extractMappedIp(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  return mapped ? (mapped[1] as string) : ip;
}

/**
 * SSRF guard: block requests to private/reserved IPs.
 *
 * Checks the raw hostname and also extracts embedded IPv4 from
 * IPv4-mapped IPv6 addresses to prevent bypass via `::ffff:127.0.0.1`.
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
}
