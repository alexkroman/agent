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
  // The subprocess backend's harness binds a random loopback port directly.
  subprocess: "http://127.0.0.1:*",
};

/**
 * `connect-src` source for browser sign-in. supabase-js dials
 * `<supabaseUrl>/auth/v1/*` straight from the page, so the Supabase project
 * is the SECOND cross-origin thing the studio does — and it hit the same wall
 * the comment above describes: `signInWithOtp` was refused before it left the
 * browser, supabase-js surfaced the resulting `TypeError` verbatim, and the
 * login screen showed a bare "Failed to fetch" under the email box with
 * nothing whatsoever on the server. Only the one cross-origin call in the
 * whole sign-in path is blocked, so the page loads and `GET /studio/auth`
 * succeeds — everything looks healthy until the button is clicked.
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
<html lang="en"><head><meta charset="utf-8"><title>AssemblyAI App Builder</title></head>
<body style="font-family:sans-serif;max-width:40rem;margin:4rem auto;line-height:1.5">
<h1>AssemblyAI App Builder</h1>
<p>The App Builder client has not been built on this server.</p>
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

// Both are fixed for the process lifetime (the sandbox backend, the auth
// binding, and the build output don't change under a running server), and
// `GET /` is the shell's hot path.
let _pageHeaders: { "Content-Security-Policy": string } | undefined;
let _pageHtml: { buf: Buffer; str: string } | undefined;

/** `GET /` — the studio app shell (or the not-built fallback). */
export async function handleStudioPage(c: AppContext): Promise<Response> {
  _pageHeaders ??= {
    "Content-Security-Policy": studioCsp(process.env, c.env.auth?.clientConfig),
  };
  const html = await readClientFile("index.html");
  if (!html) return c.html(FALLBACK_HTML, 200, _pageHeaders);
  // Decode once per cached buffer (keyed by identity, so it tracks the
  // dir reader's own cache invalidation).
  if (_pageHtml?.buf !== html) _pageHtml = { buf: html, str: html.toString("utf-8") };
  return c.html(_pageHtml.str, 200, _pageHeaders);
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
  return c.body(new Uint8Array(content), 200, {
    "Content-Type": "image/x-icon",
    "Cache-Control": "public, max-age=86400",
  });
}

/** `GET /studio-assets/:path{.+}` — hashed Vite build assets. */
export async function handleStudioClientAsset(c: AppContext): Promise<Response> {
  const rawPath = c.req.param("path") ?? "";
  const parsed = SafePathSchema.safeParse(rawPath);
  if (!parsed.success) throw new HTTPException(400, { message: "Invalid asset path" });
  const content = await readClientFile(parsed.data);
  if (!content) throw new HTTPException(404, { message: "Asset not found" });
  return c.body(new Uint8Array(content), 200, {
    "Content-Type": mime.lookup(parsed.data) || "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
}
