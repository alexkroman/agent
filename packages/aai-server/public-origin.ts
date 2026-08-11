// Copyright 2026 the AAI authors. MIT license.
/**
 * The origin browsers reach this platform on.
 *
 * **The container never sees the public scheme.** Modal terminates TLS at
 * its edge and forwards plain HTTP to the app (its ASGI proxy adds only
 * `X-Forwarded-For` — no `X-Forwarded-Proto`), so `new URL(c.req.url)`
 * inside a request handler is ALWAYS `http:`, whatever the browser used.
 *
 * Deriving the scheme from it is what broke studio Publish in production:
 * the guest was handed `http://<public host>` as the platform to deploy to,
 * its `aai deploy` POST was 308-redirected to `https://`, and `fetch` strips
 * `Authorization` across a scheme change (a different origin per the Fetch
 * spec). The request arrived — just unauthenticated — so every Publish died
 * on `401 Missing Authorization header` from its own platform, with the CLI
 * reporting an invalid API key it had in fact sent correctly. The same
 * derivation made the bare-slug redirect emit a cleartext `http://` Location.
 *
 * Resolution order:
 *
 * 1. `AAI_PUBLIC_ORIGIN` — operator config, always wins.
 * 2. `x-forwarded-host` / `x-forwarded-proto` — a real reverse proxy in
 *    front. That includes this platform's own agent→studio proxy, which
 *    sets both from THIS resolver, so the two services cannot disagree
 *    about the origin they publish.
 * 3. Otherwise infer from the host: loopback is `http` (`aai dev`, local
 *    combined runs, the test suites), everything else `https` — a public
 *    hostname served by a TLS-terminating proxy is the only case left, and
 *    guessing `http` there is the failure above. A self-hosted plaintext
 *    deployment on a public hostname must set `AAI_PUBLIC_ORIGIN`.
 *
 * Note the `x-forwarded-*` headers are caller-supplied when nothing proxies
 * this service (combined mode). The blast radius is self-directed — the
 * origin is only ever paired with the *same request's* bearer token — but
 * `AAI_PUBLIC_ORIGIN` is the way to take the choice away from callers.
 */

/** Hosts that are genuinely reached over cleartext HTTP. */
function isLoopback(host: string): boolean {
  // Strip the port; IPv6 hosts keep their brackets (`[::1]:8080`).
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "[::1]" ||
    hostname === "[::]" ||
    hostname.startsWith("127.")
  );
}

/**
 * First value of an `X-Forwarded-*` header. These accumulate through proxy
 * chains ("https, http"); the client-facing hop is the first entry.
 */
function firstForwarded(value: string | undefined): string {
  return value?.split(",")[0]?.trim() ?? "";
}

/**
 * Resolve the public origin from a request's own host plus its forwarding
 * headers, with no trailing slash.
 *
 * The header-callback form exists for the WebSocket upgrade path, which is
 * handed a raw Node `IncomingMessage` and never becomes a `Request` (see
 * orchestrator-ws.ts). {@link resolvePublicOrigin} is this function with a
 * `Request` in front of it, and is what everything else should call — the
 * resolution ORDER lives here once either way.
 */
export function publicOriginFromHeaders(
  requestHost: string,
  header: (name: string) => string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.AAI_PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const host = firstForwarded(header("x-forwarded-host")) || requestHost;
  const proto =
    firstForwarded(header("x-forwarded-proto")) || (isLoopback(host) ? "http" : "https");
  return `${proto}://${host}`;
}

/** Resolve the public origin for a request, with no trailing slash. */
export function resolvePublicOrigin(req: Request, env: NodeJS.ProcessEnv = process.env): string {
  return publicOriginFromHeaders(
    new URL(req.url).host,
    (name) => req.headers.get(name) ?? undefined,
    env,
  );
}

/**
 * The public origin split into the two `X-Forwarded-*` values a downstream
 * service needs, so a proxy forwards what the CLIENT saw rather than the
 * cleartext hop it received.
 */
export function publicForwardedHeaders(
  req: Request,
  env: NodeJS.ProcessEnv = process.env,
): { host: string; proto: string } {
  const url = new URL(resolvePublicOrigin(req, env));
  return { host: url.host, proto: url.protocol.replace(/:$/, "") };
}
