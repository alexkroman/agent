// Copyright 2025 the AAI authors. MIT license.

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
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

/** Check if a hostname is a blocked name (localhost, .local, .internal, etc.) */
function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal") ||
    lower === "metadata.google.internal" ||
    lower === "169.254.169.254"
  );
}

/** Throw if the given IP (after extracting mapped IPv4) is private. */
function assertIpNotPrivate(ip: string, label: string): void {
  const effective = extractMappedIp(ip);
  if (isPrivateIp(ip) || isPrivateIp(effective)) {
    throw new Error(`Blocked request to private address: ${label}`);
  }
}

/**
 * SSRF guard: block requests to private/reserved IPs.
 *
 * Performs hostname-based checks, DNS resolution to validate all resolved IPs,
 * and extracts embedded IPv4 from IPv4-mapped IPv6 addresses.
 *
 * This is the pre-flight check. For full DNS rebinding protection, also use
 * {@link createSsrfSafeAgent} which validates IPs at connect time.
 */
export async function assertPublicUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const effective = extractMappedIp(hostname);

  // Check the raw hostname string (catches IP literals immediately)
  if (isPrivateIp(hostname) || isPrivateIp(effective)) {
    throw new Error(`Blocked request to private address: ${hostname}`);
  }

  // Block known dangerous hostnames
  if (isBlockedHostname(hostname)) {
    throw new Error(`Blocked request to private address: ${hostname}`);
  }

  // If hostname is not an IP literal, resolve via DNS and check all results
  if (!isIpLiteral(hostname)) {
    const addresses = await resolveDns(hostname);
    for (const addr of addresses) {
      assertIpNotPrivate(addr, hostname);
    }
  }
}

/** Returns true if the string looks like an IPv4 or IPv6 address literal. */
function isIpLiteral(hostname: string): boolean {
  // IPv6 (already stripped of brackets)
  if (hostname.includes(":")) return true;
  // IPv4: all parts are numeric
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/** Resolve a hostname to all IP addresses via dns.lookup (all: true). */
function resolveDns(hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) {
        reject(new Error(`DNS resolution failed for ${hostname}: ${err.message}`));
        return;
      }
      resolve(addresses.map((a) => a.address));
    });
  });
}

/**
 * Create an HTTP/HTTPS agent that validates the resolved IP at connect time,
 * preventing DNS rebinding attacks where a hostname resolves to a public IP
 * during the pre-flight check but to a private IP when the socket connects.
 */
export function createSsrfSafeAgent(protocol: "http" | "https"): http.Agent | https.Agent {
  const Base = protocol === "https" ? https.Agent : http.Agent;
  const agent = new Base({ keepAlive: false });

  // biome-ignore lint/complexity/noBannedTypes: agent.createConnection has overloaded signatures
  const origCreateConnection = (agent.createConnection as Function).bind(agent);
  // biome-ignore lint/suspicious/noExplicitAny: overriding overloaded method
  (agent as any).createConnection = function ssrfSafeCreateConnection(...args: unknown[]) {
    const socket = origCreateConnection(...args) as import("node:net").Socket;
    socket.once("connect", () => {
      const remoteAddress = socket.remoteAddress;
      if (remoteAddress) {
        const effective = extractMappedIp(remoteAddress);
        if (isPrivateIp(remoteAddress) || isPrivateIp(effective)) {
          socket.destroy(new Error(`Blocked request to private address: ${remoteAddress}`));
        }
      }
    });
    // Also check on 'lookup' event which fires after DNS resolution but
    // before the TCP connection is established — this is the earliest point
    // we can catch a rebinding attack.
    socket.once("lookup", (_err: Error | null, address: string) => {
      if (address) {
        const effective = extractMappedIp(address);
        if (isPrivateIp(address) || isPrivateIp(effective)) {
          socket.destroy(new Error(`Blocked request to private address: ${address}`));
        }
      }
    });
    return socket;
  };

  return agent;
}
