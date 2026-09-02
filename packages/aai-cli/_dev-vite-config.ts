// Copyright 2026 the AAI authors. MIT license.
/**
 * The Vite dev server's config for a project with a `client.tsx`.
 *
 * Its own module because it is the whole agent API as the BROWSER can see it —
 * a table worth reading without the 400 lines of watcher, restart and env
 * plumbing that surround it in `_dev-server.ts`, which is also what pushed that
 * file past the length cap.
 */

import { statSync } from "node:fs";
import path from "node:path";
import { requestPath } from "@alexkroman1/aai/internal";
import { DEFAULT_LISTEN_HOST, WORKFLOW_API_PREFIX } from "@alexkroman1/aai-runtime";
import { fallbackHtmlPlugin } from "./_default-html.ts";
import { devBindHost } from "./_dev-env.ts";
import { DEDUPED_PEERS } from "./_vite-env.ts";

/**
 * The request under {@link WORKFLOW_API_PREFIX} that VITE must answer, not the
 * proxy — or `undefined` for every request the workflow API owns.
 *
 * `/workflows` is a proxy prefix key AND the directory the SDK tells authors to
 * put workflow bodies in, so the two claim the same URL space. A string key
 * prefix-matches, which is what makes one entry cover `/runs/:id/events` — and
 * it also swallowed `transcription-workflow`'s `client.tsx:173`, a value import
 * of `./workflows/stitch.ts`. Vite rewrites that specifier to the absolute
 * `/workflows/stitch.ts` during import analysis, the proxy claimed it, and the
 * agent server answered the `404 {"error":"Not found"}` its workflow router
 * gives any unmatched path under the prefix. The browser refuses a module
 * served as `application/json`, so the page rendered BLANK — and this lands on
 * the naming convention every workflow template follows, not on one template's
 * bad luck.
 *
 * ## Why the filesystem decides, and not a route table
 *
 * The obvious fix is to narrow the proxy to the API's real shape: the fourteen
 * routes are enumerable (`/runs`, `/runs/:id`, `…/events`, `…/stream`,
 * `…/wake`, `/uploads`, `…/parts`, `…/info`). That restates `aai-runtime`'s
 * router here, in a package that cannot see it — and a route added there but
 * missing from the copy 404s under `aai dev` while working deployed, which is
 * the exact silent failure this proxy table exists to prevent and the reason
 * the entry is keyed off the SDK's own constant rather than a literal. The
 * drift runs the wrong way.
 *
 * Enumerating what VITE owns inverts it: a new API route has no file behind it
 * and is proxied with nothing to update. The only thing that can shadow the API
 * is a real file at a real route's exact path — `workflows/runs` with no
 * extension, or a `workflows/runs/` directory — where an unreachable API is the
 * lesser of the two failures and the author can see the file that caused it.
 * Note `workflows/runs.ts` is NOT such a file: `/workflows/runs.ts` is neither
 * `/workflows/runs` nor under `/workflows/runs/`.
 *
 * Moving the API off `/workflows` was the third option and is the expensive one
 * — it is a wire change reaching the SDK client, the platform's broker and
 * every deployed agent, to buy what a file check buys locally.
 *
 * ## Only an EXACT file counts
 *
 * No extension resolution, deliberately: `/workflows/runs` must not find
 * `workflows/runs.ts`, and a workflow body named `runs.ts` is entirely
 * plausible. Nothing is lost by it — Vite resolves specifiers SERVER-side and
 * rewrites them to paths that exist, so an extensionless `./workflows/stitch`
 * reaches the browser as `/workflows/stitch.ts` (verified: both the explicit
 * and the bare import in one module come back with `.ts` appended). The browser
 * only ever asks for files Vite already found.
 *
 * A path escaping the root is refused rather than served — a raw client can
 * send `..` where a browser would normalize it — and a malformed percent-escape
 * is left to the API, which is where a path we cannot resolve belongs.
 */
function workflowPathServedByVite(root: string, rawUrl: string | undefined): string | undefined {
  if (rawUrl === undefined) return undefined;
  let decoded: string;
  try {
    // The query is Vite's own (`?import`, `?t=`, `?raw`), never part of the path.
    decoded = decodeURIComponent(requestPath(rawUrl));
  } catch {
    return undefined;
  }
  const base = path.resolve(root);
  const resolved = path.resolve(base, `.${decoded}`);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return undefined;
  try {
    if (!statSync(resolved).isFile()) return undefined;
  } catch {
    return undefined;
  }
  // Unchanged, so Vite sees the request it would have seen with no proxy at all
  // — query included, which its transform pipeline reads.
  return rawUrl;
}

/**
 * Vite dev-server config for the client SPA. Extracted so the proxy wiring
 * is unit-testable: `/websocket` MUST proxy with `ws: true` or `aai dev`
 * with a `client.tsx` serves a page whose WebSocket never connects.
 *
 * **This table is the whole agent API as the browser can see it**, which is
 * the thing to hold in mind before adding a route to `createServer`. Vite owns
 * the port the user is told to open and answers everything not listed here
 * itself — with a bare 404 carrying none of the agent server's headers, so the
 * failure looks like a missing route rather than a missing proxy entry.
 *
 * `/workflows` is why that matters beyond voice. A WORKFLOW APP
 * (`workflowApp()`) has no session and no socket: `page()` mounts a
 * form and every single thing it does — listing workflows, starting a run,
 * polling it, streaming its events — is a same-origin `fetch` under that
 * prefix. Unproxied, the two workflow-app templates were dead on arrival under
 * `aai dev` (`404 POST /workflows/runs` the instant the form is submitted)
 * while the backend served the API correctly one port over. A string key
 * prefix-matches, so this one entry covers `/runs`, `/runs/:id` and the
 * `/runs/:id/events` SSE stream.
 *
 * `strictPort` because the reported URL is `http://localhost:<port>` —
 * without it, Vite silently binds port+N when the port is busy and the
 * printed/JSON-returned URL points at whatever else was listening.
 *
 * `AAI_DEV_HOST` reaches BOTH servers. Binding only the backend left Vite —
 * the port the user is told to open — on loopback, i.e. failing exactly the
 * case that variable exists for (`aai dev` in a container, reached from the host).
 *
 * ## With no `AAI_DEV_HOST` the bind host is the BACKEND's, not Vite's default
 *
 * Vite's default `server.host` is the hostname `localhost`, so Node binds
 * whatever `getaddrinfo` returns first — `::1` on macOS, usually `127.0.0.1` on
 * Linux. Measured here: `vite.httpServer.address()` reported
 * `{ address: "::1", family: "IPv6" }` and `http://127.0.0.1:<port>` was
 * ECONNREFUSED while `http://localhost:<port>` worked. So the same command
 * produced different reachability per machine, and `aai dev` reports
 * `http://localhost:<port>` either way — a caller that resolves IPv4-only, or
 * dials the literal, gets a connection refused against a server that is up.
 *
 * The two halves of `aai dev` also disagreed: `createServer` binds
 * {@link DEFAULT_LISTEN_HOST} explicitly, Vite took its own default, and only a
 * set `AAI_DEV_HOST` brought them back together. Taking the same constant is
 * what makes them agree by construction rather than by two matching literals.
 *
 * IPv4 loopback is the SAFE side of that choice rather than a coin flip:
 * browsers, curl and undici all try every address `localhost` resolves to, so a
 * `127.0.0.1` bind stays reachable as `localhost`, while a `::1` bind is not
 * reachable at all from a client holding the IPv4 literal.
 *
 * ## The target is an IP LITERAL, and that is a fix rather than a style choice
 *
 * `127.0.0.1`, never `localhost`. Vite opens a FRESH upstream connection for
 * every WebSocket upgrade — an HTTP request reuses a pooled keep-alive socket and
 * so resolves rarely — which means a hostname here is one `getaddrinfo` per
 * session handshake. That lookup runs on libuv's threadpool (four threads,
 * shared with every other fs and DNS call in a process that is ALSO serving the
 * agent), and under load it intermittently stalls for almost exactly two
 * seconds.
 *
 * Measured on the `retail` template, session handshakes to `session.configured`:
 *
 * | Target | conc | rps | p50 | p99 |
 * | --- | --- | --- | --- | --- |
 * | `localhost` | 1 | 12-18 | 8-11 ms | 2.0 s |
 * | `localhost` | 10 | 0.6 | 16.7 s | 16.7 s |
 * | `127.0.0.1` | 1 | 89-207 | 4-9 ms | 23-49 ms |
 * | `127.0.0.1` | 20 | 260 | 73 ms | 166 ms |
 *
 * The `localhost` row is not a slow proxy, it is a queue: one handshake in thirty
 * stalls two seconds on its own, and at concurrency 10 the stalls pile onto four
 * threads until a sustained burst left the proxy refusing upgrades entirely until
 * the dev server was restarted. With the literal it recovers from a burst and
 * sits within ~1.5x of the backend port.
 *
 * Localized by timing the phases separately — TCP connect and the first frame
 * were always fast, the 101 was not — and then by comparing the instant the
 * client sent its upgrade against the backend's own log line for it: 23.808 out,
 * 25.796 in, answered in 5 ms. The two seconds were spent before Vite dialled,
 * which is what pointed at resolution rather than at either server.
 *
 * Not a behaviour change: `localhost` resolved to loopback anyway, so this
 * removes the lookup and nothing else. An `AAI_DEV_HOST` that binds the backend
 * to ONE non-loopback interface was unreachable through the proxy before this and
 * still is.
 */
export function viteDevConfig(
  cwd: string,
  vitePort: number,
  backendPort: number,
): import("vite").InlineConfig {
  const target = `http://127.0.0.1:${backendPort}`;
  return {
    root: cwd,
    plugins: [fallbackHtmlPlugin(cwd)],
    // The same peer contract `buildClient` states, for the same reason and a
    // different symptom — see DEDUPED_PEERS. Without it a project whose SDK is
    // linked rather than installed loads two Reacts and renders a blank page.
    resolve: { dedupe: DEDUPED_PEERS },
    server: {
      port: vitePort,
      strictPort: true,
      // Always set, and to the same constant the backend binds — see the
      // IPv6 note above. Vite's own default is the HOSTNAME `localhost`,
      // which resolves to `::1` first on macOS.
      host: devBindHost() ?? DEFAULT_LISTEN_HOST,
      proxy: {
        "/health": target,
        "/client-config": target,
        "/websocket": { target, ws: true },
        // The workflow HTTP API. See the doc comment above: this is the entire
        // front door of a `page: "static"` app, not an extra. `bypass` is what
        // keeps the project's own `workflows/` SOURCE out of the prefix's
        // reach — see `workflowPathServedByVite`.
        [WORKFLOW_API_PREFIX]: {
          target,
          bypass: (req) => workflowPathServedByVite(cwd, req.url),
        },
      },
    },
  };
}
