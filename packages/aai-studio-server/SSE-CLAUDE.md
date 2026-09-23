---
summary: >-
  The studio's two long-lived event streams: shutdown, timeouts and heartbeats
  for the only long-lived responses the combined deployment serves
read_when: >-
  touching `GET /studio/events`, a project's event stream, or the lifecycle
  under them
---

# packages/aai-studio-server — long-lived responses

A SIBLING of `packages/aai-studio-server/CLAUDE.md`, read on demand: that guide
is at its 120,000-character cap, and this section is REFERENCE for someone
already working in this area.

## Long-lived responses (SSE)

The studio's two event streams — `GET /studio/events` and
`GET /studio/projects/:project/events` — are the ONLY long-lived responses the
combined deployment serves, so everything a long-lived response needs is here
even though the mechanism (`live-streams.ts`, `serve-lifecycle.ts`,
`modal_deploy.py`'s `FUNCTION_TIMEOUT_SECS`) lives in `aai-server`. That guide
keeps the two rules an author editing it must not lose — shutdown ends
registered streams before the sandbox teardown, and any new long-lived response
owes registration; what follows is why, and what the log looks like when it
works.

- **Shutdown ENDS long-lived responses; it must never let the process exit
  destroy them** (`live-streams.ts`, wired into `serve-lifecycle.ts`). SSE
  streams never end on their own, so `server.close()` waited out
  `SHUTDOWN_CLOSE_FALLBACK_MS` and `process.exit(0)` then destroyed the
  sockets — cutting each chunked body before its terminating `0\r\n\r\n`.
  That is a protocol error to whatever is reading, and in production the
  reader is Modal's in-container ASGI proxy, which surfaced it as a recurring
  unretrieved-task `ClientPayloadError: Response payload is not completed:
  <TransferEncodingError: 400, 'Not enough data to satisfy transfer length
  header.'>` on `GET /studio/projects/<x>/events`, with nothing tying it to a
  replica scale-in. The studio's SSE pusher (`studio-sse.ts`) registers; with
  both surfaces in one process that is the only place a stream is owned. (The
  split deployment additionally relayed proxied streams through one it owned —
  `gracefulEventStream`, `text/event-stream` only so assets and JSON stayed
  zero-copy — because the browser's connection terminated at the agent replica;
  reviving the split owes that back.) Ending them is also what lets
  `server.close()` complete, so shutdown stops hitting the fallback timer at
  all. The client sees a clean stream end and resubscribes on its existing
  backoff (`useEventStream`). Any future long-lived response owes the same
  registration — the wire-level guard is `live-streams.test.ts`, which reads
  raw socket bytes because a handler-level assertion passes with the bug
  present.

  Three properties of the ending itself, each of which was a hole that put the
  truncation back while the registry looked correct:
  - **It runs FIRST, before the service teardown.** Ending a stream is
    synchronous and depends on nothing, while `onShutdown` sleeps
    `SHUTDOWN_GRACE_MS` and then awaits one drain request per resident guest —
    seconds at best, and up to `SHUTDOWN_TEARDOWN_TIMEOUT_MS` when a guest is
    unreachable or still booting (it was genuinely unbounded before that
    deadline existed). Modal SIGKILLs the container when its stop grace lapses,
    so ending them *after* the teardown made the graceful end contingent on
    sandbox teardown finishing in time — which is a bound now, but still not a
    dependency worth having.
  - **The registry LATCHES closed.** Nothing drains it twice, so a stream
    registered after shutdown began would be held open until the exit destroyed
    it; `registerLiveStream` therefore ends a late arrival on the spot instead.
    That is not the rare case — the client's first reconnect backoff is 3s and
    shutdown deliberately keeps serving for `SHUTDOWN_GRACE_MS`, so a
    resubscribe landing mid-shutdown is the MODAL case. (`resetLiveStreams` is
    a test-only seam for the latch.)
  - **The crash path ends them too** (`installProcessSafetyNets` in
    `service-config.ts`): `uncaughtException` → `process.exit(1)` destroys
    sockets exactly as a scale-in does.
- **A caller's concurrent streams are CAPPED per scope**
  (`MAX_LIVE_STREAMS_PER_SCOPE`, enforced by `reserveLiveStream` in
  `aai-server/live-streams.ts`; both routes answer **429** when a scope is at
  it). These are the only unbounded resource a single caller could hold on this
  surface: they were capped by nothing — `liveStreamCount()` was computed and
  gated on nowhere — and metered by nothing, since the studio's limiters cover
  chat, project-create and preview-wake only.

  **A cap, not a rate limit, and the distinction is why the limiters were the
  wrong tool.** A stream is a concurrent resource, so what matters is how many
  are held at once; a fixed-window limiter meters ARRIVALS and would punish
  exactly the honest client this protects, because every tab reconnects at once
  after a deploy or a scale-in (`endLiveStreams`) — a window sized for steady
  state refuses the reconnect storm the system itself caused.

  50 is far above legitimate use (a tab holds two: the scope list plus one
  project) and far below where streams cost a replica anything — measured, one
  replica held **2,000** concurrent streams at ~100 KB each with CPU at ~0% and
  a fresh request's p50 unchanged, and those streams consumed **zero** database
  connections, being fed by Realtime rather than by polling.

  Two properties, both load-bearing. The reservation is taken BEFORE
  `streamSSE` — like the project route's 404, since once the response is a
  stream there is no status left to send — and released in a **`finally`**
  around the whole callback, not in `sse.wait`'s cleanup: everything between
  the pusher and `wait` can throw (a reader, a watcher subscribe), and a slot
  leaked that way is not a slow leak but one scope permanently answered 429
  until the replica restarts. And the key is the SCOPE, never the project: a
  per-project key would let a caller cycling project names hold unlimited
  streams, the same evasion that made the scope-keyed rate limits decorative
  before they were paired with an IP key.
- **A long-lived connection is ONE Modal input, so the function `timeout`
  bounds CALL DURATION** — not request latency. The app therefore sets it
  explicitly (`FUNCTION_TIMEOUT_SECS` = 4h, matching
  `DEFAULT_SANDBOX_TIMEOUT_MS`). Left unset, Modal's default is **300s**, and it
  severed every in-process session (the old `?host=1` host mode, since
  removed) at exactly five minutes, mid-word — the client saw a bare "not
  connected" and the server logged nothing, because nothing in our code did
  it. No session runs in the server process anymore — browser voice sessions
  dial the guest sandbox's tunnel directly, and `/:slug/websocket` upgrades
  are handshake redirects — but the studio's SSE streams sit under the same
  cap, so it stays pinned rather than inherited. The sandbox layer hit the same
  trap first and documents it in `modal/sandbox-env.ts`.

  **The 4h ceiling is load-bearing for the studio's event streams, which is a
  trap for anyone re-splitting the deployment.** The removed studio app set 30
  min, reasoned as headroom for a cold-sandbox Publish on the premise that
  "nothing here is long-lived by design" — true of WebSockets (chat streams
  browser→guest directly) and false of `GET /studio/events` and
  `GET /studio/projects/:project/events`, which a browser holds open for as long
  as a project is on screen and which did not exist when that value was set. It
  never bit, because combined mode serves those routes under the 4h. A revived
  studio service would start reaping them at 30 minutes.

  **Most `TransferEncodingError`s in the log are NOT truncation we caused.**
  Measured over 6h of production `aai-server-web` logs (2026-08-05): 38 SSE
  stream completions, 40 of these errors, pairing 1:1 by timestamp — at every
  duration from 25s to 1375s, and continuing across a redeploy that shipped the
  registry above. Modal's `_proxy_http_request.send_response()` is still
  iterating the upstream body when the client goes away, and Modal never awaits
  that task ("Task exception was never retrieved"), so ONE lands in the log per
  abandoned stream. The browser is already gone when it fires. Two corollaries
  before treating a spike as a regression: **join it to Modal's request log
  first** — the `duration` on the completion line at the same second is the
  stream's whole lifetime, which is what separates a client abort (any
  duration, all of them multiples of `SSE_HEARTBEAT_MS`, because nothing in the
  chain notices a departed client until data flows) from a real deadline (a
  tight cluster at one value); and a rise in the count usually means a client is
  churning subscriptions, not that a stream was cut.

  **So the container COLLAPSES each one to a single line**
  (`install_proxy_noise_filter` in `scripts/modal_image.py`, installed at the
  top of `server()` in `modal_deploy.py`). Left whole they are the log's
  dominant content and they crowd out the thing you opened it for: across one
  60-minute production window they were ~600 of ~3,200 lines while the service
  served **zero 5xx** — and the window in question also held 13 failed
  container starts and a `crash-looping` line that took a targeted grep to
  find. The twenty-odd frames are Modal and aiohttp internals, identical every
  time and actionable never.

  **Collapsed, NOT dropped**, because the count and the timing are the entire
  diagnostic — the rule above is to join a RISE to the request log, and a
  deleted record makes that impossible. It stays a record on the `asyncio`
  logger, at the same level, carrying its exception type; only the traceback
  goes. It is also matched on TWO discriminators (the exception name **and**
  `_proxy_http_request` in the record), so it can never decay into swallowing
  asyncio errors: one of our own tasks dying the same way, or Modal's proxy
  task dying of anything else, still prints in full. `modal/image-inputs.test.ts`
  pins all three properties, which is worth the ceremony because every way this
  rots is silent and in the same direction — toward eating a traceback you
  needed, in a log nobody reads until an incident.

  **Capping the streams' own lifetime was considered and rejected.** It cannot
  reduce the above — a tab close still aborts whatever stream is open — while
  `projectPayload` carries `files: workspace.files`, so every forced recycle
  re-sends the whole workspace file map to every open tab. If a split studio
  service ever ships, raise its function timeout rather than adding a cap under
  it.
