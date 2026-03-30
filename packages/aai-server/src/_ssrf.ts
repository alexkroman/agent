// Copyright 2025 the AAI authors. MIT license.
/**
 * SSRF protection for the platform server.
 *
 * Validates URLs against private/reserved IP ranges and handles redirects
 * safely by re-validating each redirect target.
 */

import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";

const privateBlocks = new BlockList();

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

function extractMappedIp(ip: string): string {
  const mappedDotted = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mappedDotted) return mappedDotted[1] as string;
  const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1] as string, 16);
    const lo = Number.parseInt(mappedHex[2] as string, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return ip;
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal") ||
    lower === "169.254.169.254"
  );
}

function isLiteralIp(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

async function assertDnsResolvesPublic(hostname: string): Promise<void> {
  try {
    const { address } = await Promise.race([
      lookup(hostname),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("DNS lookup timed out")), 2000);
      }),
    ]);
    const resolved = extractMappedIp(address);
    if (isPrivateIp(address) || isPrivateIp(resolved)) {
      throw new Error(`Blocked request: ${hostname} resolves to private address ${address}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Blocked request")) throw err;
  }
}

export async function assertPublicUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const effective = extractMappedIp(hostname);

  if (isPrivateIp(hostname) || isPrivateIp(effective)) {
    throw new Error(`Blocked request to private address: ${hostname}`);
  }
  if (isBlockedHostname(hostname)) {
    throw new Error(`Blocked request to private address: ${hostname}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked request with disallowed protocol: ${parsed.protocol}`);
  }
  if (!isLiteralIp(hostname)) {
    await assertDnsResolvesPublic(hostname);
  }
}

const MAX_REDIRECTS = 5;

export async function ssrfSafeFetch(
  url: string,
  init: RequestInit,
  fetchFn: typeof globalThis.fetch,
): Promise<Response> {
  await assertPublicUrl(url);
  let currentUrl = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const resp = await fetchFn(currentUrl, { ...init, redirect: "manual" });
    if (resp.status < 300 || resp.status >= 400) return resp;
    const location = resp.headers.get("location");
    if (!location) return resp;
    currentUrl = new URL(location, currentUrl).href;
    await assertPublicUrl(currentUrl);
  }
  throw new Error("Too many redirects");
}
