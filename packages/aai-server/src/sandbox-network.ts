// Copyright 2025 the AAI authors. MIT license.
/**
 * Network policy and adapter for sandbox isolates.
 *
 * Restricts isolate network access to the per-sandbox sidecar server
 * on loopback while exempting it from SSRF checks.
 */

import { createDefaultNetworkAdapter } from "secure-exec";
import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const SidecarUrlSchema = z
  .string()
  .url()
  .refine((u) => LOOPBACK_HOSTS.has(new URL(u).hostname), "Sidecar server must be on loopback");

/**
 * Build a network permission check that restricts the isolate to:
 *   1. Listening on loopback (its own harness HTTP server)
 *   2. DNS lookups for loopback hostnames only
 *   3. fetch/http to the sidecar server URL only
 *
 * Everything else (cloud metadata, internal services, external hosts) is denied.
 */
export function buildNetworkPolicy(sidecarUrl: string) {
  const parsed = new URL(SidecarUrlSchema.parse(sidecarUrl));
  const allowedHost = parsed.hostname;
  const allowedPort = parsed.port;

  const AllowedRequestSchema = z.object({
    url: z
      .string()
      .url()
      .refine((u) => {
        const t = new URL(u);
        return t.hostname === allowedHost && t.port === allowedPort;
      }, "URL must target the sidecar server"),
  });

  return (req: { op: string; url?: string; hostname?: string }) => {
    if (req.op === "listen") return { allow: true };
    if (req.op === "dns") {
      return LOOPBACK_HOSTS.has(req.hostname ?? "")
        ? { allow: true }
        : { allow: false, reason: "DNS lookups restricted to loopback" };
    }
    const result = AllowedRequestSchema.safeParse(req);
    return result.success
      ? { allow: true }
      : { allow: false, reason: "Network restricted to sidecar server" };
  };
}

/**
 * Build a network adapter that wraps the default but exempts the sidecar
 * URL from SSRF checks. The default adapter blocks all private IPs (including
 * 127.0.0.1), but the isolate needs to reach the sidecar on loopback.
 */
export function buildNetworkAdapter(sidecarUrl: string) {
  const defaultAdapter = createDefaultNetworkAdapter();
  const sidecarOrigin = new URL(sidecarUrl).origin;

  return {
    ...defaultAdapter,
    async fetch(
      url: string,
      options: { method?: string; headers?: Record<string, string>; body?: string | null },
    ) {
      // Sidecar calls bypass SSRF — they're our own capability server on loopback
      if (url.startsWith(sidecarOrigin)) {
        const res = await globalThis.fetch(url, {
          method: options.method ?? "GET",
          ...(options.headers != null && { headers: options.headers }),
          ...(options.body !== undefined && { body: options.body }),
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          headers,
          body: await res.text(),
          url: res.url,
          redirected: res.redirected,
        };
      }
      // Everything else goes through the default adapter (with SSRF checks)
      return defaultAdapter.fetch(url, options);
    },
  };
}
