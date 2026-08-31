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
 * Note the `Host` and `x-forwarded-*` headers are ALL caller-supplied: Modal's
 * proxy forwards the client's `Host` and adds no `x-forwarded-host`, and in
 * combined mode nothing rewrites either. What that costs depends entirely on
 * where the answer goes:
 *
 * - **Within the request that asked** — a redirect `Location`, the URL a
 *   carrier signed, the `x-forwarded-*` pair handed to a downstream hop — it is
 *   self-directed. A caller who lies about the host gets its own lie back.
 * - **Anywhere it OUTLIVES the request** it is an injection, because the next
 *   reader is somebody else. That is why {@link rememberPublicOrigin} does not
 *   record one in production: see its doc.
 *
 * `AAI_PUBLIC_ORIGIN` is the way to take the choice away from callers, and it
 * is what a deployment that mints durable URLs owes.
 */

import { isLocalDev, platformOwnPort } from "./_boot.ts";
import { HOST_ALIAS } from "./microsandbox-network.ts";

/** Strip the port. IPv6 hosts keep their brackets (`[::1]:8080`). */
function hostnameOf(host: string): string {
  return host.replace(/:\d+$/, "").toLowerCase();
}

/**
 * Hosts that name THIS machine, and so identify the server rather than
 * describing where a caller thinks it is.
 *
 * This is the set {@link rememberPublicOrigin} is willing to LEARN from, which
 * is why it excludes {@link HOST_ALIAS} while {@link isCleartextHost} includes
 * it: the alias is this machine as a guest sees it, not an origin anything
 * outside a microVM can resolve.
 */
function isLoopback(host: string): boolean {
  const hostname = hostnameOf(host);
  return (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "[::1]" ||
    hostname === "[::]" ||
    hostname.startsWith("127.")
  );
}

/**
 * Hosts that are genuinely reached over cleartext HTTP.
 *
 * Loopback, plus the host alias a microVM guest reaches this dev server on.
 * That alias is not loopback and would otherwise fall to the `https` branch
 * below — so a guest's own request resolved to a TLS origin against a
 * plaintext port, and every URL derived from it failed the handshake. It only
 * exists under the `microsandbox` backend, which only local dev selects, and
 * that server is always plaintext.
 */
function isCleartextHost(host: string): boolean {
  return isLoopback(host) || hostnameOf(host) === HOST_ALIAS;
}

/**
 * The `host` of an origin string, or `""` when it does not parse.
 *
 * `""` is not loopback, so an unparseable `AAI_PUBLIC_ORIGIN` is simply never
 * OBSERVED — which costs nothing, that variable being read directly wherever
 * the origin is resolved.
 */
function originHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
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
    firstForwarded(req.headers.get("x-forwarded-proto")) ||
    (isCleartextHost(host) ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * The last origin this replica resolved for a request it was willing to LEARN
 * from — local dev only. See {@link rememberPublicOrigin}.
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
 * Record the origin of a request being served — IN LOCAL DEV ONLY — and return
 * the resolved origin either way.
 *
 * Called from the shared platform middleware, so both surfaces feed it and no
 * route has to remember. `AAI_PUBLIC_ORIGIN` still wins wherever the value is
 * read, so an operator who sets it never depends on what was observed.
 *
 * **Why production learns nothing.** The origin resolves from `Host` /
 * `x-forwarded-host`, which are the CALLER'S to write, and this middleware runs
 * on every request before any auth — `GET /health` included. What it writes is
 * read by {@link agentPublicBaseUrl} at the next SPAWN, for ANY slug and any
 * tenant, and baked into that guest as `AAI_PUBLIC_BASE_URL`. One
 * `curl -H 'Host: evil.example' <replica>/health` therefore made the next
 * sandbox this replica booted mint `https://evil.example/<slug>/…` from
 * `ctx.workflows.publicWebhookUrl(token)` — a URL its author hands to a payment
 * provider. The callback then delivers the payload and the run token to the
 * attacker, and the run never resumes. Unauthenticated, cross-tenant, and
 * durable past the request that caused it, which is exactly the line the module
 * doc above draws: an origin that outlives its request is an injection.
 *
 * There is no header a server can distinguish from a forged one, so the
 * production answer is not a better check — it is refusing to guess. With
 * nothing observed, `agentPublicBaseUrl` returns `undefined`, the boot env omits
 * the key, and the SDK throws naming `publicUrl` the first time an author asks
 * for a durable URL. That is the failure this was designed for, it is loud, and
 * it is one env var to fix: `AAI_PUBLIC_ORIGIN`.
 *
 * Local dev keeps the observation because requiring config for
 * `pnpm dev:aai-server` would be pure friction, and it is an explicit
 * `AAI_LOCAL_DEV=1` rather than an inference, so nothing a deployment forgets
 * can reach this branch.
 *
 * **But it only learns from a LOOPBACK host, and that is not defence in depth
 * — it is the same bug, twice, in the environment that was excused from it.**
 * This used to observe whatever any caller wrote, on the premise that local dev
 * has "no tenant boundary to cross and no attacker to cross it". Both halves of
 * that premise failed:
 *
 * - **A guest is a caller now.** The `microsandbox` backend's in-guest
 *   `aai deploy` POSTs back to this platform with `Host:
 *   host.microsandbox.internal:8080`, so tenant code poisoned this on every
 *   Publish as a matter of course — and the resulting `AAI_PUBLIC_BASE_URL` is
 *   a name that resolves ONLY inside a microVM, which is worse than useless
 *   for the one thing it is for. Measured: a deploy reported
 *   `Deployed http://host.microsandbox.internal:8080/<slug>` and the value
 *   flip-flopped with whoever made the last request.
 * - **The forged header still worked.** `curl -H 'Host: evil.example'
 *   localhost:8080/health` redirected the developer's very next deploy to
 *   `https://evil.example/deploy` — the production hole above, reachable by
 *   anything that can reach the dev server's port.
 *
 * A loopback `Host` is the one form that IDENTIFIES this server rather than
 * describing where a caller thinks it is, and it is exactly what
 * `pnpm dev:aai-server` produces — so the friction argument survives intact.
 * A local run that must publish some other origin (a tunnel, for webhook
 * testing) sets `AAI_PUBLIC_ORIGIN`, which is what that variable is for and
 * always wins.
 */
export function rememberPublicOrigin(req: Request, env: NodeJS.ProcessEnv = process.env): string {
  const origin = resolvePublicOrigin(req, env);
  if (isLocalDev(env) && isLoopback(originHost(origin))) observedOrigin = origin;
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
 *
 * **In production the only source is `AAI_PUBLIC_ORIGIN`**, because nothing else
 * is the operator's word — see {@link rememberPublicOrigin} for what an observed
 * one costs. A deployment that mints durable webhook URLs must set it; one that
 * does not is unaffected, and gets the throw above rather than a wrong URL if it
 * ever starts.
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
 * The base URL a GUEST dials this platform on — the origin plus its slug.
 *
 * The twin of {@link agentPublicBaseUrl} and deliberately a different function,
 * because the two answer opposite questions about the same value:
 *
 * | | {@link agentPublicBaseUrl} | this |
 * | --- | --- | --- |
 * | Claim | "a third party reaches the agent here" | "the guest reaches the platform here" |
 * | Reader | `ctx.workflows.publicWebhookUrl` | `resolvePlatformQueue` |
 * | Must be | resolvable from the internet | resolvable from inside the sandbox |
 *
 * One key served both, and under the `microsandbox` backend the two requirements
 * point in OPPOSITE directions — which is the bug this split closes. The public
 * one must not be rewritten to `HOST_ALIAS` (a webhook URL minted from it is
 * unreachable for exactly the caller it is for), so it was not, so the guest
 * dialled the loopback origin it was handed — and `GUEST_PORT` and
 * `DEFAULT_PORT` are BOTH 8080, so `127.0.0.1:8080` inside the microVM is the
 * guest's own harness. Every platform call looped back to its caller and the
 * guest's own 404 handler answered it:
 *
 *     guest stderr: POST /<slug>/workflow-storage 404
 *     guest stderr: POST /<slug>/workflow-enqueue 404
 *     Workflow API request failed { error: 'storage runs.list answered HTTP 404 }
 *
 * That is the same 404-to-itself `platformHostPort` in microsandbox-sandbox.ts
 * documents for an in-guest `aai deploy`, and the same one the retired
 * local-container backend was retired over — third occurrence, and the first
 * where the dial side has a name of its own. `guestReachableUrl` is what
 * rewrites it.
 *
 * **In local dev it is DERIVED, so nothing has to be configured.** A dial base
 * does not need to be publicly correct, only reachable — so this server's OWN
 * port is both a better source than an observed `Host` header and an
 * authoritative one where the header is a caller's guess. That is why
 * `pnpm dev:aai-server` and a studio preview need no `AAI_PUBLIC_ORIGIN` for
 * durable runs to work, and it takes this value off
 * {@link rememberPublicOrigin} entirely: a preview's platform calls no longer
 * depend on which request happened to be observed last.
 *
 * Outside local dev it is {@link agentPublicBaseUrl} unchanged — a Modal guest
 * reaches the platform over the internet on the very origin a third party uses,
 * so there is nothing to derive and `AAI_PUBLIC_ORIGIN` stays the one source.
 */
export function agentPlatformBaseUrl(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // Operator config still wins, for the reason it wins everywhere else: a local
  // run pointed at a tunnel has SAID where this platform is, and deriving over
  // the top of that would be this function guessing against an explicit answer.
  if (!env.AAI_PUBLIC_ORIGIN?.trim() && isLocalDev(env)) {
    return `http://127.0.0.1:${platformOwnPort(env)}/${slug}`;
  }
  return agentPublicBaseUrl(slug, env);
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
