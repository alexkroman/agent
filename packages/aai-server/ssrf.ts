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

export function isPrivateIp(ip: string): boolean {
  return bogon(ip);
}

function isLiteralIp(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

async function assertDnsResolvesPublic(hostname: string): Promise<void> {
  try {
    const { address } = await pTimeout(lookup(hostname), {
      milliseconds: 2000,
      message: "DNS lookup timed out",
    });
    if (isPrivateIp(address)) {
      throw new Error(`Blocked request: ${hostname} resolves to private address ${address}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Blocked request")) throw err;
    throw new Error(`Blocked request: DNS resolution failed for ${hostname}`, { cause: err });
  }
}

export async function assertPublicUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked request with disallowed protocol: ${parsed.protocol}`);
  }
  if (isPrivateIp(hostname)) {
    throw new Error(`Blocked request to private address: ${hostname}`);
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
