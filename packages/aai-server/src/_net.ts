// Copyright 2025 the AAI authors. MIT license.

const _PRIVATE_RANGES_V4: [number, number, number][] = [
  // [start, end (inclusive), unused] encoded as 32-bit integers
];

// deno-fmt-ignore
const PRIVATE_CIDRS: { prefix: string; bits: number }[] = [
  { prefix: "0.0.0.0", bits: 8 },
  { prefix: "10.0.0.0", bits: 8 },
  { prefix: "100.64.0.0", bits: 10 },
  { prefix: "127.0.0.0", bits: 8 },
  { prefix: "169.254.0.0", bits: 16 },
  { prefix: "172.16.0.0", bits: 12 },
  { prefix: "192.0.0.0", bits: 24 },
  { prefix: "192.168.0.0", bits: 16 },
  { prefix: "198.18.0.0", bits: 15 },
  { prefix: "224.0.0.0", bits: 4 },
  { prefix: "240.0.0.0", bits: 4 },
];

const _PRIVATE_V6 = ["::1", "::", "fc00::", "fe80::", "ff00::"];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".");
  return (
    ((Number(parts[0]) << 24) |
      (Number(parts[1]) << 16) |
      (Number(parts[2]) << 8) |
      Number(parts[3])) >>>
    0
  );
}

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  for (const { prefix, bits } of PRIVATE_CIDRS) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) === (ipv4ToInt(prefix) & mask)) return true;
  }
  return false;
}

function isPrivateV6(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe80")) return true;
  if (normalized.startsWith("ff")) return true;
  return false;
}

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) return isPrivateV6(ip);
  return isPrivateV4(ip);
}

/**
 * SSRF guard: block requests to private/reserved IPs.
 * In workerd, DNS resolution is handled by the runtime, so we only
 * check the hostname for obviously-private patterns.
 */
export function assertPublicUrl(url: string): void {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  // Check if hostname is a literal IP
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`Blocked request to private address: ${hostname}`);
    }
  } else if (hostname.includes(":")) {
    if (isPrivateIp(hostname)) {
      throw new Error(`Blocked request to private address: ${hostname}`);
    }
  }

  // Block localhost variants
  if (hostname === "localhost" || hostname.endsWith(".local")) {
    throw new Error(`Blocked request to private address: ${hostname}`);
  }
}
