---
summary: >-
  The harness's agent mode: boot contract, the bundle fetch and hash check,
  the manage surface and its derived token, guest-owned idle/drain lifecycle,
  the log ring, the debug-logging forward, and `/phone`.
read_when: >-
  editing `src/harness/` — agent-mode boot, `/manage/*`, logs, the bundle
  source, or anything a deployed agent guest does at runtime.
---

# packages/aai-guest/src/harness — agent mode

Package-wide rules (modes, dev/prod parity, user-shipped runtime, network,
credentials, the image) are in `packages/aai-guest/CLAUDE.md`. The host side of
spawning is `packages/aai-server/CLAUDE.md`.

## Agent guests are servers (no control channel)

Deployed agents spawn as servers (`spawnAgentServer` in `aai-server`'s
`sandbox/vm.ts`; guest side `agent-mode.ts`). The platform↔agent contract is
frozen per deploy by the harness image pin and versioned by
`GUEST_CONTRACT_VERSION` — **additive changes only**.

- **Boot.** The spawner writes the agent env as a FILE, then execs with
  `AAI_GUEST_MODE=agent`, the artifact locations and `AAI_BUNDLE_SHA256`. The
  bundle arrives as EITHER `AAI_BUNDLE_PATH` (a written file) OR
  `AAI_BUNDLE_URL` (a signed Storage URL, production) — mutually exclusive, no
  precedence rule. The guest hash-verifies either way (a mismatch is a hard boot
  failure), loads the bundle BEFORE listening, and scrubs the env file.
- **Readiness** is public `/health` answering 200, polled by the host and raced
  against process exit; guest stderr is relayed from process start
  (`startGuestLogging`) so a boot crash is explained.
- **Boot budget ≠ client wait.** The broker caps its wait at
  `BROKER_READY_TIMEOUT_MS` (20s; 0 = whole boot budget) and answers 503 while
  the boot continues; the pending sandbox stays attached so the next call joins
  the same readiness promise instead of spawning another. Boot itself is bounded
  by `AGENT_HEALTH_TIMEOUT_MS` (120s).
- **Ongoing surface**: `GET /manage/status` (session count, draining,
  `contractVersion` — diagnostic only) and `POST /manage/drain?deadlineMs=`,
  both behind the per-sandbox bearer. Nothing else — no WebSocket, no RPC, no
  host connection. Public `/client-config` doubles as the broker's
  name/greeting source.
- **Lifecycle is guest-owned; the host runs NO idle machinery.** The guest
  self-exits after `AGENT_IDLE_EXIT_MS` (5 min) idle — override with
  `AAI_GUEST_IDLE_EXIT_MS` on the SERVER, which `agentBootEnv` forwards. The
  exit surfaces host-side as `onSandboxLost`; the next broker call rebuilds. A
  drained guest refuses new sessions (close 1013 → client re-brokers) and exits
  when empty or at its drain deadline.
- **"Busy" = sessions + running durable-workflow WALKS**
  (`createWorkflowActivity`, counted by `createIdleController` for idle and
  drain). A woken run has no session. **The unit is the walk, not the HTTP
  response**: the counter takes `activity.walk(() => deliver(runId))` and settles
  in the walk's own `finally`, because the platform aborts a delivery's `fetch`
  at `QUEUE_DELIVERY_TIMEOUT_MS` (60s) without stopping the walk. A PARK is
  credited nothing; a walk that never settles pins the guest until
  `SANDBOX_TIMEOUT_SECS` (deliberate — bound a step with its own deadline). A
  drain's deadline still wins. Details in `createWorkflowActivity`'s doc.
- **Wake hint.** A workflow guest with a database publishes the earliest time
  its queue could next have work (`aai/host/workflow-wake-hint.ts`) at boot and
  after every queue callback, for the platform's wake sweep.
- **Redeploys hand over blue-green** (`handoverSlot`, `sandbox/resolve.ts`): the
  new sandbox must be ready before the old one detaches; a replacement that
  fails to boot still retires the old resident (fail visibly, never serve
  superseded code).

## Fetching its own bundle

`AAI_BUNDLE_URL` comes from `BlobStorage.signedUrl` → `BundleStore.getWorkerUrl`
→ `WorkerSource` in `sandbox/vm.ts`, so the ~8 MB bundle never crosses the
platform replica. `bundle-source.ts` is the guest half.

- **The hash is the security argument**: `readAgentBoot` trusts
  `AAI_BUNDLE_SHA256` — the agents row's `worker_hash` — never the transport.
  The URL reads one immutable blob, carries no service-role key, and expires
  (`WORKER_URL_TTL_SECONDS`, 5 min, sized over the 120s readiness budget).
- **No fallback on failure.** Signing throws → the spawn fails. `signedUrl`
  returning `null` means only "this backend cannot sign" (the memory blob store
  in dev/tests), which takes the byte path. Never conflate the two.
- **Old pinned guests don't understand URLs** — `GUEST_CONTRACT_VERSION` 1 reads
  only `AAI_BUNDLE_PATH`. `guestUnderstandsBundleUrl` allows a URL only with no
  pin, `SANDBOX_IGNORE_IMAGE_PINS` (must agree with `resolveSpawnImage`), or a
  pin equal to the server's own harness tag.

## Why the buffer lives in the guest

`logs.ts` tees both process streams into a bounded cursor-indexed ring
(`createLogBuffer`, `@alexkroman1/aai-runtime`), served at `GET /manage/logs` —
the source for the studio Logs pane and `aai logs`. It lives in the GUEST
because a sandbox is resident on one replica and replicas never proxy for each
other; the guest's own URL is reachable from all of them.

- The ring dies with the sandbox — recent output only. A bundle that throws at
  LOAD exits before binding, so its stderr is only in the host log (the studio
  reports it via `previewError`).
- **Capture is a `process.stdout/stderr.write` tee, not a console patch** (that
  catches traces and direct fd writes); the original write still runs. `main()`
  installs it before anything else writes.
- The studio coding agent reads another guest's ring via `read_logs` — see
  `packages/aai-guest-studio/CLAUDE.md`.

## Turning a deployed guest's debug logging ON

`AAI_DEBUG` on the PLATFORM SERVER is forwarded into agent guests' boot env by
`agentBootEnv` (`aai-server/warm-harness.ts`), only when set. A guest inherits
nothing else from the host — that is what keeps platform credentials out.

- The runtime reads debug flags from `process.env` at import time, and a
  deployed agent's own env is never merged into `process.env`. **Any future
  runtime knob read off `process.env` needs the same one-line forward.**
- Takes effect at guest BOOT only (redeploy or idle exit), and is per REPLICA.
- Only `AAI_DEBUG` is forwarded. Not `LOG_LEVEL=DEBUG` (a generic host name
  that would arm tenant logging by accident), not `AAI_DEBUG_PARTIALS` (too
  noisy).

Read output from the host log or `aai logs`.

## The manage token is derived, not random

`AAI_GUEST_TOKEN` is an HMAC over the sandbox's fleet-wide name
(`aai-server/guest-token.ts`, over `agentSandboxName(slug, version)`), so every
replica can compute it and `/manage/*` is not replica-local. Preserved:
unguessable without the platform secret, distinct per sandbox, rotated on
redeploy. Given up: rotation on respawn of the same version. Unset
`AAI_GUEST_TOKEN_SECRET` falls back to a per-process key, announced at boot.

## A phone call is an ordinary session

`WS /phone` (SDK `aai/host/telephony/`, served by `createRuntimeServer` here and
under `aai dev`) runs a carrier media stream (Twilio, Telnyx) as an ordinary
session — **only for carriers the agent declares** (`agent({ telephony:
["twilio"] })`), identically everywhere. The TwiML webhook route is "Telephony"
in `packages/aai-server/CLAUDE.md`.

**Nothing below the bridge knows about telephony.** `createTelephonyBridge` is a
socket-shaped shim speaking the client protocol one side and carrier JSON the
other, handed to `runtime.startSession`. Never add a telephony branch below it;
if one seems needed, the bridge is the wrong shape.

- **Pacing stays ON**; no `audioLeadMs`, and barge-in also sends the carrier's
  `clear` frame — the carrier buffers on the far side where
  `PacedAudioSink.clear()` can't reach ("Host-mode audio pacing" in
  `packages/aai-cli/CLAUDE.md`).
- **Rates are LEARNED from the `config` frame**, not configured (the guest's
  runtime is a lazy facade that can't answer a rate before the first session).
- **Downsampling low-passes first; both converters are STATEFUL**
  (`telephony/resample.ts`; `telephony/mulaw.ts` keeps G.711 sample-exact).
- This is consistent with "the host does not resample": the bridge IS the edge.
- **Adding a carrier is one `CarrierCodec`** in `telephony/carriers.ts`; its doc
  lists what every codec owes (decode never throws; non-`inbound` media dropped).
- Known gaps, deliberate: no `mark` frames (pipeline uses its open-loop
  estimate); DTMF ignored.
