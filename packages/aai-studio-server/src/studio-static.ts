// Copyright 2025 the AAI authors. MIT license.
/**
 * Serves the studio's React client — the `aai-studio-client` workspace
 * package's Vite build output (`pnpm --filter aai-studio-client build`),
 * resolved the same way the default agent client resolves from aai-ui
 * (see transport-websocket.ts).
 *
 * `GET /` returns the app shell; hashed assets are served under
 * `/studio-assets/` (a reserved slug, so no agent route can shadow them).
 * When the client has not been built (fresh checkout unit tests, partial
 * self-hosted setups) a minimal fallback page explains how to build it.
 */

import { createRequire } from "node:module";
import path from "node:path";
import type { AppContext } from "aai-server/context";
import { createCachedDirReader } from "aai-server/platform-barrel";
import { resolveSandboxBackend, type SandboxBackend } from "aai-server/sandbox-backend";
import { SafePathSchema } from "aai-server/schemas";
import type { StudioAuthClientConfig } from "aai-server/supabase-auth";
import { HTTPException } from "hono/http-exception";
import mime from "mime-types";

/**
 * `connect-src` sources for the guest sandbox, per sandbox backend.
 *
 * Every asset the studio loads is same-origin, but the coding agent's chat
 * and tool-label calls are NOT: the browser talks straight to the project's
 * sandbox (`chatUrlForGuest` in studio-session-broker.ts), the same way
 * voice sessions connect directly to a deployed agent. Those origins have to
 * be here or the browser refuses the request before it is sent — which
 * presents as a bare "Failed to fetch" in the client with NOTHING on the
 * server, since no request was ever made.
 *
 * Keyed by backend rather than listing both unconditionally so a production
 * policy never trusts loopback.
 */
const SANDBOX_CONNECT_SRC: Record<SandboxBackend, string> = {
  // Modal tunnels: `https://<tunnel>.modal.host:<port>` (port is not fixed).
  modal: "https://*.modal.host:*",
  // A microVM publishes the guest's port on loopback, so the browser reaches it
  // at the same shape the subprocess backend serves directly.
  microsandbox: "http://127.0.0.1:*",
  // The subprocess backend's harness binds a random loopback port directly.
  subprocess: "http://127.0.0.1:*",
};

/**
 * `connect-src` source for browser sign-in. supabase-js dials
 * `<supabaseUrl>/auth/v1/*` straight from the page (the session restore and
 * the OAuth code/token exchange when the GitHub redirect lands back here),
 * so the Supabase project is the SECOND cross-origin thing the studio does —
 * and it hit the same wall the comment above describes: the sign-in fetch
 * was refused before it left the browser, supabase-js surfaced the
 * resulting `TypeError` verbatim, and the login screen showed a bare
 * "Failed to fetch" with nothing whatsoever on the server. Only the one
 * cross-origin call in the whole sign-in path is blocked, so the page loads
 * and `GET /studio/auth` succeeds — everything looks healthy until the
 * button is clicked. (GitHub itself needs no entry: the hop to github.com
 * is a top-level navigation, which connect-src does not govern.)
 *
 * Derived from the config the server actually hands the client rather than
 * re-read from `SUPABASE_URL`, so the policy cannot come to name a different
 * project than the login screen dials. The exact origin, never
 * `https://*.supabase.co`, which would trust every Supabase project there is.
 *
 * Dev auth (`mode: "dev"`) mints its token in the browser and needs nothing:
 * an unconfigured or local-dev login adds no source at all.
 */
function authConnectSrc(auth: StudioAuthClientConfig | undefined): string[] {
  if (auth?.mode !== "supabase") return [];
  try {
    return [new URL(auth.supabaseUrl).origin];
  } catch (cause) {
    // Silently omitting it is the bug this function exists to fix, so name it.
    throw new Error(`SUPABASE_URL is not a valid URL: ${auth.supabaseUrl}`, { cause });
  }
}

/**
 * The studio page's CSP. Scripts are external files (no inline JS);
 * `frame-src 'self'` lets the studio preview deployed agents in an iframe
 * (they are served through the agent service's proxy, so same-origin);
 * `font-src 'self'` serves the self-hosted brand fonts.
 */
export function studioCsp(
  env: NodeJS.ProcessEnv = process.env,
  auth?: StudioAuthClientConfig,
): string {
  const connect = [
    "'self'",
    SANDBOX_CONNECT_SRC[resolveSandboxBackend(env)],
    ...authConnectSrc(auth),
  ];
  return (
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    `connect-src ${connect.join(" ")}; img-src 'self' data:; frame-src 'self'; font-src 'self'; ` +
    "base-uri 'none'; form-action 'none'"
  );
}

const FALLBACK_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>AssemblyAI Build</title></head>
<body style="font-family:sans-serif;max-width:40rem;margin:4rem auto;line-height:1.5">
<h1>AssemblyAI Build</h1>
<p>The AssemblyAI Build client has not been built on this server.</p>
<p>Run <code>pnpm --filter aai-studio-client build</code> and restart, then
reload this page to use the browser coding agent.</p>
</body></html>`;

let _clientDir: string | undefined;
/** The aai-studio-client package's Vite build output. */
function clientDir(): string {
  if (!_clientDir) {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("aai-studio-client/package.json");
    _clientDir = path.join(path.dirname(pkgPath), "dist");
  }
  return _clientDir;
}

// Cached, containment-checked reads over the studio client build.
const readClientFile = createCachedDirReader(clientDir);

/**
 * The shell is the ONE response that must never outlive the build it names.
 *
 * `index.html` references content-hashed assets that exist only in the
 * container image it was built into, and those assets are served
 * `immutable` — so the shell is the exact inverse: cache it and a browser
 * pins itself to a build whose `/studio-assets/*` are gone the moment that
 * image stops running. A Modal deploy is precisely that event, and it is
 * not instantaneous: the default rolling strategy keeps old containers
 * serving alongside new ones (they linger up to `scaledown_window`, 300s in
 * `aai-server/modal_deploy.py`), and Modal load-balances every request
 * independently. A cached shell therefore turns into a hard 404 on the
 * entry script — a white page with no JS running to recover from it.
 *
 * It carried NO cache headers at all, which is not the same as "not
 * cached": with no `Cache-Control` and no validator, a heuristically
 * caching intermediary is free to reuse it. `no-store` says the quiet part
 * out loud, and costs one ~2 kB revalidation-free fetch per navigation.
 */
const SHELL_CACHE_CONTROL = "no-store";

// Both are fixed for the process lifetime (the sandbox backend, the auth
// binding, and the build output don't change under a running server), and
// `GET /` is the shell's hot path.
let _pageHeaders: { "Content-Security-Policy": string; "Cache-Control": string } | undefined;
let _pageHtml: { buf: Buffer; str: string } | undefined;

/** `GET /` — the studio app shell (or the not-built fallback). */
export async function handleStudioPage(c: AppContext): Promise<Response> {
  _pageHeaders ??= {
    "Content-Security-Policy": studioCsp(process.env, c.env.auth?.clientConfig),
    "Cache-Control": SHELL_CACHE_CONTROL,
  };
  const html = await readClientFile("index.html");
  if (!html) return c.html(FALLBACK_HTML, 200, _pageHeaders);
  // Decode once per cached buffer (keyed by identity, so it tracks the
  // dir reader's own cache invalidation).
  if (_pageHtml?.buf !== html) _pageHtml = { buf: html, str: html.toString("utf-8") };
  return c.html(_pageHtml.str, 200, _pageHeaders);
}

/**
 * A zero-copy view of a CACHED buffer, for handing bytes to `c.body`.
 *
 * `new Uint8Array(buf)` — which both asset handlers used to call — allocates
 * and COPIES the whole file per request, and these buffers come from
 * `createCachedDirReader`, i.e. they are already resident and immutable. A
 * cold studio page load pulls ~1.7 MB of js/css/woff2, so that was ~1.7 MB
 * copied and immediately collected per new browser, per replica. A view over
 * the same memory costs one small object. (`c.body` will not take a `Buffer`
 * directly — hence a view rather than the buffer itself.)
 */
function viewOf(buf: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength);
}

/**
 * `GET /favicon.ico` — the studio icon, for the default browser request
 * (the built studio shell links it at `/studio-assets/favicon.ico`, but
 * the not-built fallback page and non-browser clients hit the root path).
 * 404s when the client has not been built.
 */
export async function handleStudioFavicon(c: AppContext): Promise<Response> {
  const content = await readClientFile("favicon.ico");
  if (!content) throw new HTTPException(404, { message: "Favicon not found" });
  return c.body(viewOf(content), 200, {
    "Content-Type": "image/x-icon",
    "Cache-Control": "public, max-age=86400",
  });
}

/**
 * `GET /robots.txt` — served from CODE, not from the client build.
 *
 * Every host under this deployment is an authenticated app plus a namespace of
 * TENANT agent pages at `/:slug/`, and neither is content anybody should be
 * indexing: the studio needs a session to show anything, and what an agent's
 * page says is its author's business rather than ours to publish. So the policy
 * is a blanket disallow, and it stays one line to relax if a public surface ever
 * lands on this host.
 *
 * Not a `public/` asset, unlike `favicon.ico`, and the difference is what a
 * MISSING file means. A 404 favicon is cosmetic; a 404 here makes a crawler
 * apply its own default, so the policy would silently depend on whether the
 * studio client happened to be built. It is also the shortest possible file,
 * with nothing to gain from the build.
 */
export function handleStudioRobots(c: AppContext): Response {
  return c.text("User-agent: *\nDisallow: /\n", 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "public, max-age=86400",
  });
}

/**
 * `GET /studio-assets/:path{.+}` — hashed Vite build assets.
 *
 * **A missing asset while this replica is DRAINING is a 503, not a 404.** The
 * shell doc above explains the race and closes half of it: Modal's rolling
 * deploy keeps old containers serving next to new ones and load-balances every
 * request independently, so a browser can take `index.html` from the new build
 * and have its entry `<script>` land on a replica running the old one. Making
 * the shell `no-store` stops a browser PINNING itself to a dead build; it
 * cannot stop that one cross-build request.
 *
 * What it left was the wrong STATUS on it. Production served
 * `GET /studio-assets/assets/index-ByztzOpq.js -> 404` on the same second as
 * `Shutting down (retiring guests)...`, and the identical URL answered 200
 * forty-one seconds later — so 404 was false twice over: the asset exists, and
 * the condition is transient. It also invites an intermediary to CACHE the
 * negative answer, which turns a self-healing blip into a sticky white page for
 * whoever is behind that cache.
 *
 * Gated on `isDraining` rather than on the path's SHAPE, deliberately: no
 * heuristic can tell a hashed asset from another build apart from a typo'd
 * path, and answering 503 to a genuinely nonexistent asset would say "retry"
 * forever. While draining, "this replica does not have this build" is simply
 * what is true, and a 404 is still the answer everywhere else.
 */
export function studioClientAssetHandler(
  isDraining?: () => boolean,
): (c: AppContext) => Promise<Response> {
  return async function handleStudioClientAsset(c: AppContext): Promise<Response> {
    const rawPath = c.req.param("path") ?? "";
    const parsed = SafePathSchema.safeParse(rawPath);
    if (!parsed.success) throw new HTTPException(400, { message: "Invalid asset path" });
    const content = await readClientFile(parsed.data);
    if (!content && isDraining?.()) {
      // `Retry-After: 1` because the replacement replica is already serving —
      // this one is on its way out, not overloaded.
      return c.json({ error: "Asset not on this replica (draining)" }, 503, {
        "Retry-After": "1",
        "Cache-Control": "no-store",
      });
    }
    if (!content) throw new HTTPException(404, { message: "Asset not found" });
    return c.body(viewOf(content), 200, {
      "Content-Type": mime.lookup(parsed.data) || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  };
}
