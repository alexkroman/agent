# The guest→platform socket

Reference for ONE wire, whose two ends live in two packages:
`packages/aai-runtime/src/platform-socket.ts` (the guest dials) and
`packages/aai-server/src/platform-socket-handler.ts` (the platform answers).

A SIBLING of this package's guide rather than a section in it, for the reason
`AGENTS.md` gives for `MODAL-CLAUDE.md` and `SCHEMA-CLAUDE.md`: every guide in
this repo is at the 120,000-character cap, and no single package owns both ends
of this. Read it when you are changing either end, the frame schema, or the
capacity assumptions. Nothing in it is needed to work elsewhere.

## What changed

A deployed guest's five platform calls — session state, upload records, the
replay engine's journal, its correlation-key index, and an enqueue — were each a
`POST` on a pooled HTTP/1.1 connection (`_egress-fetch.ts`'s `rpcFetch`). They
now ride ONE WebSocket per guest process, opened once and shared by all five
clients.

**The routes did not change, and neither did anything above the transport.** A
frame names one of `PLATFORM_ROUTES` and carries the same already-encoded body
the `POST` carried; the platform turns it back into a real `Request` and runs it
through the same Hono app. So `platform-rpc.ts`'s error taxonomy, every client's
`errorFor`, `RETRYABLE_STATUS`, the `{result}` envelope and each caller's own
deadline all keep working unread. That is the property that made this safe to do
at all, and the reason the swap lives under `platformPost` rather than in five
clients.

The five HTTP routes are UNCHANGED and still serve every call. They are the
fallback, and they are what an older guest image (pinned at deploy time) keeps
using.

## The wire

Four frames, declared once in `aai-runtime/platform-socket-frames.ts` and parsed
on both ends. One JSON object per text frame.

| Direction | Frame |
| --- | --- |
| guest → platform | `{t:"req", id, route, traceparent?, body}` |
| platform → guest | `{t:"res", id, status, body}` |
| guest → platform | `{t:"ping", id}` |
| platform → guest | `{t:"pong", id}` |

**Not JSON-RPC**, though this repo speaks it on the host→guest control socket
(`rpc-transport.ts`). JSON-RPC's reply is `result` XOR `error`, and every one of
these five routes answers an HTTP STATUS the guest-side clients already read — a
409 is `claim` refusing an id, a 404 is a run this agent does not own, and a 501
is a deployment without the feature. Mapping that onto `error.code` and back
would be a lossy translation on the one path where the status IS the contract.

**A frame this build does not recognise is dropped, never fatal.** That is how a
newer peer would add one; closing over it would turn a forwards-compatible
addition into an outage on every guest.

## HTTP is the fallback, and the boundary is the WRITE

`platformPost` prefers the socket and uses `rpcFetch` whenever there is not an
open one — the first call of a process (the connect is still in flight), a
platform that predates the route, a socket that is reconnecting. Nothing here can
fail a call that HTTP would have served.

Which call may be retried over HTTP is a CORRECTNESS question, not a tidiness
one, and the answer is the frame write:

| Situation | Code | What the caller does |
| --- | --- | --- |
| no socket, or the in-flight cap is reached, or the write threw | `PLATFORM_SOCKET_UNAVAILABLE` | uses HTTP — the platform provably never saw it |
| the socket died with the frame already written | `PLATFORM_UNAVAILABLE` (what a 503 carries) | rethrown; the engine's own retry decides |

Re-sending a WRITTEN frame over HTTP would run one `appendEvents` twice. The
second row is exactly what an HTTP connection reset already did, so the
at-least-once boundary is unchanged.

## The heartbeat is the one failure HTTP did not have

A pooled `fetch` has undici's keep-alive and per-request connect handling
underneath it. A WebSocket that is silently black-holed stays `OPEN` forever, so
every call on it would burn its own deadline and the socket would never recover.

So the guest pings every `HEARTBEAT_MS` (20 s) and tears the socket down when a
pong does not arrive within `PONG_DEADLINE_MS` (10 s), failing the calls on it
with the retryable code and reconnecting on a jittered backoff. An APPLICATION
ping rather than the protocol's own: this socket crosses Modal's proxy, and a
protocol pong proves the PROXY is alive rather than the Node process behind it.
The application ping is answered by the same loop that answers requests, so a
wedged loop fails the heartbeat.

The platform's own half is `PLATFORM_SOCKET_IDLE_MS` (90 s): a socket that has
sent no frame in that window is closed, so a guest that vanished without a close
cannot hold an input forever.

## The two caps, and why they are different numbers

| | guest, `MAX_INFLIGHT` | platform, `MAX_SOCKET_INFLIGHT` |
| --- | --- | --- |
| value | 64 | 128 |
| over it | refuse before writing → HTTP | answer 503 |

The guest's is deliberately the one that binds: its refusal costs a caller
nothing, where a 503 is a real answer that has to be retried. The platform's is
the backstop for a peer that is not ours, and it exists at all because each
dispatch may reserve one of `ADMIN_POOL_MAX` connections — an unbounded socket is
one tenant queueing the pool every other tenant reads through.

## The tenant boundary

- The upgrade path names the slug, and the bearer is checked against it with the
  same policy every guest-called route runs — `konsistent.json`'s
  `platform-socket-handler`.
- Every frame is dispatched under THAT slug. A frame names a route, never an
  agent, so it cannot reach another tenant's rows.
- `route` is checked against `PLATFORM_ROUTES` before a `Request` is built. This
  is a BOUNDARY rather than a validation: the value is concatenated into a URL,
  so an unchecked `/../elsewhere/session-state` normalizes away from its own slug
  and paths outside `/:slug` are not gated by the guest bearer at all.
- The per-route bearer check still runs underneath, and is not redundant: a bearer
  is verified against the agent's CURRENT version, so a redeploy during the life
  of a socket invalidates it — the next frame answers 401 and the guest reconnects
  with the token its new sandbox holds.

## What it costs the web service

A WebSocket is ONE Modal input for its whole lifetime, so a running agent guest
now holds an input on some replica for as long as it lives, where before it made
short requests any replica could serve. `modal_deploy.py` carries the accounting
against `MAX_INPUTS` (400 per container) and `FUNCTION_TIMEOUT_SECS` (4 h, which
bounds a socket's life — the guest treats that cut as any other close).

Three things keep exhaustion survivable, and they are the reason the fallback is
not vestigial: the idle reaper, a draining replica refusing new sockets, and a
guest with no socket falling back to `POST`s. The ceiling costs latency, not
availability.

## What is deliberately NOT on the socket

- **Upload BYTES.** `blobFetch` and its pool are untouched: multi-megabyte bodies
  do not belong in JSON text frames, and that pool's shape is the one that was
  measured (`_egress-fetch.ts`).
- **The live stream read.** A GET whose response is meant to stay open; it has no
  deadline and shares only `platformBearer`.
- **`perMessageDeflate`.** Off, matching every other socket this repo opens. These
  bodies WOULD compress, unlike the PCM `_ws.ts` measured, but the zlib context
  pair is paid whether or not a frame benefits and nothing has measured the trade
  here. One line and one measurement away; inheriting it is not the same thing.

## Where the tests are, and what each can see

| Tier | File | Sees |
| --- | --- | --- |
| unit | `aai-runtime/platform-socket.test.ts` | the guest end against a fake peer: correlation, the refusal taxonomy, the heartbeat on virtual time, reconnect |
| unit | `aai-runtime/platform-rpc.test.ts` | the transport CHOICE — prefer, fall back on a refusal, never retry a written call |
| unit | `aai-server/platform-socket-handler.test.ts` | the frame loop against a real Hono app: dispatch, the route allowlist, ping, the in-flight cap, the handshake refusals |
| scenario | `aai-server/platform-socket.scenario.test.ts` | both REAL ends over a real port: the handshake, the bearer, and a socket answer compared byte for byte against the same call over HTTP |

The scenario one is the only tier that can say the two ends are wired to each
other at all — every unit suite either side passes against a fake peer.

## An unmeasured transport change

`_egress-fetch.ts` states the bar this did not clear: *"nothing has measured the
RPC path either way, and an unmeasured change to the transport under every
durable run is not a change to make on a plausible argument."* That is still
true of what the SOCKET saves. What makes it shippable anyway is the fallback —
it can only ever be a latency change, because a call it cannot serve is served by
the same HTTP route as before.

What IS measured is the hop underneath it, and by somebody else: `modal_deploy.py`
records **~24 ms an operation out of region against ~2 ms in it** for exactly
these calls, which is what put guest sandboxes on the web service's own region
list. That is the distance a socket does not change. What it removes is the
per-call connection setup on top of it, and the two numbers still worth taking
are that saving — against the ~840 ms journal round trip decomposed in
`packages/aai-runtime/CLAUDE.md` — and the input pressure above under real guest
counts.
