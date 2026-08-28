// Copyright 2026 the AAI authors. MIT license.
/**
 * The Vite dev server's config for a project with a `client.tsx`.
 *
 * Its own module because it is the whole agent API as the BROWSER can see it —
 * a table worth reading without the 400 lines of watcher, restart and env
 * plumbing that surround it in `_dev-server.ts`, which is also what pushed that
 * file past the length cap.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { WORKFLOW_API_PREFIX } from "@alexkroman1/aai-runtime";
import { fallbackHtmlPlugin } from "./_default-html.ts";
import { devBindHost } from "./_dev-env.ts";
import { DEDUPED_PEERS } from "./_vite-env.ts";

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
      // Omitted rather than `undefined`: Vite reads this key's PRESENCE.
      ...omitUndefined({ host: devBindHost() }),
      proxy: {
        "/health": target,
        "/client-config": target,
        "/websocket": { target, ws: true },
        // The workflow HTTP API. See the doc comment above: this is the entire
        // front door of a `page: "static"` app, not an extra.
        [WORKFLOW_API_PREFIX]: target,
      },
    },
  };
}
