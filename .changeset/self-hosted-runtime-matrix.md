---
"@alexkroman1/aai-cli": patch
---

Make a self-hosted deployment runnable under any of Node, Deno and Bun — and certify it under all three.

The emitted deployment is a directory with no `node_modules`, no toolchain and one file to boot, so which runtime an operator puts in front of it is their choice. It was not: each long-lived entry read `PORT` through one runtime's global — `globalThis.Deno.env` in the Deno entry, `process.env` in the Modal one — so `.aai/deno/` ignored `PORT` under `node` and `bun` while looking perfectly healthy on its default. Both entries now come from one shared source (`RUNTIME_PORT_SOURCE` reads either runtime), differing only in a banner and a default port.

`_target-runtimes.scenario.test.ts` is the new gate: one bundle, booted under `node`, `deno` and `bun` in turn, each arm asserting the emit boots with no `node_modules`, serves `/health`, `/client-config` and `/`, **dials `/websocket`** and exits 0 on SIGTERM. Nothing dialled a session before — all three host suites probed HTTP only, and the `ws`-over-`node:http` upgrade is the part of `node:http` compatibility a reimplementation is likeliest to get wrong. The bundle's `node:` imports are pinned to a portable set as well, which is what catches a dependency dragging `node:vm` or `node:cluster` into a deployment before a live session does.

Bun needed a version FLOOR, and the matrix is what found it. Under 1.3.x the emit died on import — undici assigns `webidl.util.markAsUncloneable` unguarded from `node:worker_threads`, which Bun did not implement, and undici's `CacheStorage` calls it at module scope — and past that the `/websocket` upgrade wrote zero bytes to the client (raw-socket measured; server-side `handleUpgrade` ran and a session was created first). Both close at **1.4.0**, so `minVersion` is declared on that arm, CI pins 1.4.2, and a binary below the floor is treated as an absent one: announced, skipped, and a hard failure under `AAI_REQUIRE_BUN`. All three runtimes now boot, serve, accept a session and drain.

The `ws` half is worth remembering for its shape rather than its fix: it was never a general gap in Bun's `node:http`. The same nine-line `ws` + `node:http` server worked under Bun 1.3.11 when `ws` was imported by NAME, because Bun substitutes its own native implementation for the package — and failed identically to the emit when the same script imported ws's real JavaScript by path. A bundle inlines that JavaScript, so the substitution never happens.
