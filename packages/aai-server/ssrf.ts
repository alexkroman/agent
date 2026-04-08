// Copyright 2025 the AAI authors. MIT license.
/**
 * SSRF protection for the platform server.
 *
 * Validates URLs against private/reserved IP ranges and handles redirects
 * safely by re-validating each redirect target.
 */

import { lookup } from "node:dns/promises";
import bogon from "bogon";
import pTimeout from "p-timeout";

const BLOCKED_TLDS = [".internal", ".local", ".localhost"];
const BLOCKED_HOSTS = new Set(["metadata.google.internal", "instance-data.ec2.internal"]);

export function isPrivateIp(ip: string): boolean {
  return bogon(ip);
}

function isLiteralIp(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

async function assertDnsResolvesPublic(hostname: string): Promise<string> {
  try {
    const { address } = await pTimeout(lookup(hostname), {
      milliseconds: 2000,
      message: "DNS lookup timed out",
    });
    if (isPrivateIp(address)) {
      throw new Error(`Blocked request: ${hostname} resolves to private address ${address}`);
    }
    return address;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Blocked request")) throw err;
    throw new Error(`Blocked request: DNS resolution failed for ${hostname}`, { cause: err });
  }
}

export async function assertPublicUrl(url: string): Promise<string | null> {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked request with disallowed protocol: ${parsed.protocol}`);
  }
  if (BLOCKED_HOSTS.has(hostname) || BLOCKED_TLDS.some((tld) => hostname.endsWith(tld))) {
    throw new Error(`Blocked request to reserved hostname: ${hostname}`);
  }
  if (isPrivateIp(hostname)) {
    throw new Error(`Blocked request to private address: ${hostname}`);
  }
  if (!isLiteralIp(hostname)) {
    return assertDnsResolvesPublic(hostname);
  }
  return null;
}

const MAX_REDIRECTS = 5;

/**
 * Replace the hostname in a URL with a resolved IP to pin DNS resolution
 * and prevent TOCTOU DNS rebinding attacks.
 */
function pinResolvedIp(url: string, resolvedIp: string): { pinnedUrl: string; host: string } {
  const parsed = new URL(url);
  const host = parsed.host;
  const isIpv6 = resolvedIp.includes(":");
  parsed.hostname = isIpv6 ? `[${resolvedIp}]` : resolvedIp;
  return { pinnedUrl: parsed.href, host };
}

export async function ssrfSafeFetch(
  url: string,
  init: RequestInit,
  fetchFn: typeof globalThis.fetch,
): Promise<Response> {
  let resolvedIp = await assertPublicUrl(url);
  let currentUrl = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    let fetchUrl = currentUrl;
    const headers = new Headers(init.headers);
    if (resolvedIp) {
      const { pinnedUrl, host } = pinResolvedIp(currentUrl, resolvedIp);
      fetchUrl = pinnedUrl;
      headers.set("Host", host);
    }
    const resp = await fetchFn(fetchUrl, { ...init, headers, redirect: "manual" });
    if (resp.status < 300 || resp.status >= 400) return resp;
    const location = resp.headers.get("location");
    if (!location) return resp;
    currentUrl = new URL(location, currentUrl).href;
    resolvedIp = await assertPublicUrl(currentUrl);
  }
  throw new Error("Too many redirects");
}
