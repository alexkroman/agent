---
"@alexkroman1/aai": patch
---

Fix a two-second stall on every `aai dev` session handshake behind a `client.tsx`.

`viteDevConfig`'s proxy targets named `localhost`, and Vite opens a FRESH
upstream connection for every WebSocket upgrade — an HTTP request reuses a
pooled keep-alive socket and so resolves rarely. That made a hostname one
`getaddrinfo` per session handshake, on libuv's four-thread pool, shared with
every other fs and DNS call in a process that is also serving the agent. Under
load that lookup intermittently stalls for almost exactly two seconds.

Measured on the `retail` template, handshakes to `session.configured`:

| Target | conc | rps | p50 | p99 |
| --- | --- | --- | --- | --- |
| `localhost` | 1 | 12-18 | 8-11 ms | 2.0 s |
| `localhost` | 10 | 0.6 | 16.7 s | 16.7 s |
| `127.0.0.1` | 1 | 89-207 | 4-9 ms | 23-49 ms |
| `127.0.0.1` | 20 | 260 | 73 ms | 166 ms |

The `localhost` rows are a queue rather than a slow proxy: one handshake in
thirty stalled on its own, and at concurrency 10 the stalls piled up until a
sustained burst left the proxy refusing upgrades entirely until the dev server
was restarted. With the literal it recovers from a burst and sits within ~1.5x
of the backend port.

Localized by timing the handshake phases separately — TCP connect and the first
frame were always fast, the 101 was not — and then by comparing the instant the
client sent its upgrade against the backend's own log line for it: 23.808 out,
25.796 in, answered in 5 ms, so the two seconds were spent before Vite dialled.

Not a behaviour change: `localhost` resolved to loopback anyway, so this removes
the lookup and nothing else. A test now asserts every target in the table is an
IP literal, so a route added later cannot reintroduce it.
