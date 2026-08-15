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
function firstForwarded(value: string | null): string {
  return value?.split(",")[0]?.trim() ?? "";
}

/** Resolve the public origin for a request, with no trailing slash. */
export function resolvePublicOrigin(req: Request, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AAI_PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const url = new URL(req.url);
  const host = firstForwarded(req.headers.get("x-forwarded-host")) || url.host;
  const proto =
    firstForwarded(req.headers.get("x-forwarded-proto")) || (isLoopback(host) ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * The last origin this replica RESOLVED for a real request.
 *
 * Derived config, not state: losing it costs one re-observation, no request
 * reads it, and nothing coordinates on it — so it does not breach the
 * stateless-server rule (see the platform guide). It exists because a SPAWN
 * needs the public origin and three of the four spawn paths hold no request:
 * the blue-green handover fires off the agents-row change stream, the durable-run
 * wake sweep fires off a timer, and the peer route answers before either. The
 * broker's own request is the only one that could carry it, and baking a
 * per-request value would be a fiction anyway — there is ONE sandbox per slug
 * fleet-wide, so whichever request happened to spawn the guest decides for every
 * later caller regardless.
 */
let observedOrigin: string | undefined;

/**
 * Record the origin of a request being served, and return it.
 *
 * Called from the shared platform middleware, so both surfaces feed it and no
 * route has to remember. `AAI_PUBLIC_ORIGIN` still wins wherever the value is
 * read, so an operator who sets it never depends on what was observed.
 */
export function rememberPublicOrigin(req: Request, env: NodeJS.ProcessEnv = process.env): string {
  const origin = resolvePublicOrigin(req, env);
  observedOrigin = origin;
  return origin;
}

/**
 * Forget the observed origin. Tests only — module state outlives
 * `restoreMocks`/`unstubEnvs`, so a spec asserting the unobserved case has to
 * be able to get back to it.
 *
 * @internal
 */
export function forgetObservedPublicOrigin(): void {
  observedOrigin = undefined;
}

/**
 * The public base URL of ONE agent — the origin plus its slug — or `undefined`
 * when this replica cannot name an origin yet.
 *
 * This is what `AAI_PUBLIC_BASE_URL` carries into a guest, and it is the only
 * thing a durable webhook URL can be built from: `getWorkflowMetadata().url` is
 * the guest's own `http://localhost:<port>`, and the sandbox that minted it is
 * gone by the time a payment provider calls back (see "Durable workflows" in
 * this package's guide).
 *
 * `undefined` rather than a guess. The SDK then has no `publicUrl` and
 * `ctx.workflows.webhookUrl()` THROWS naming the option, which is the whole
 * point: a `localhost` URL handed to a third party fails weeks later, at them,
 * with nothing here to look at.
 */
export function agentPublicBaseUrl(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env.AAI_PUBLIC_ORIGIN?.trim().replace(/\/+$/, "");
  const origin = configured || observedOrigin;
  return origin ? `${origin}/${slug}` : undefined;
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
