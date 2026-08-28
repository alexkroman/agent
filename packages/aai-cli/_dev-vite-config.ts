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
 * ## Do not BENCHMARK a session through this port
 *
 * The `/websocket` hop has a tail that is Vite's, not the agent's, and measuring
 * it will send you looking for a bug in the runtime that is not there. Measured
 * on the `retail` template, session handshakes to `session.configured`:
 *
 * | Target | rps | p50 | p99 |
 * | --- | --- | --- | --- |
 * | the backend port, direct | 338 | 26 ms | 102 ms |
 * | this port, through the proxy | 12-26 | 8-46 ms | 2.0-8.7 s |
 *
 * So the median is fine — which is what a developer opening one session
 * experiences, and why this is not worth re-architecting — while roughly one
 * handshake in thirty stalls for almost exactly 2 s, and a sustained burst
 * degrades further (one run left the proxy refusing upgrades entirely until the
 * dev server was restarted). It is NOT this table's target hostname: `localhost`
 * resolves IPv4-only here, so no Happy-Eyeballs fallback is involved.
 *
 * Benchmark the BACKEND port. `startDevServer` picks it (`port + 1` upward), the
 * boot log names it, and it serves the same routes with no proxy in front.
 */
export function viteDevConfig(
  cwd: string,
  vitePort: number,
  backendPort: number,
): import("vite").InlineConfig {
  const target = `http://localhost:${backendPort}`;
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
