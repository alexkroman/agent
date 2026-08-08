# packages/aai-guest — guest harness guide

The Node entrypoint that runs the complete agent inside each Modal Sandbox
(private package). How the host spawns and supervises it is in
`packages/aai-server/CLAUDE.md`; the studio coding agent that runs in studio
mode is in `packages/aai-studio-server/CLAUDE.md`.

## The harness: one binary, two modes

The Node guest entry point (runs inside a Modal Sandbox) runs the COMPLETE
agent. ONE BINARY, TWO MODES, selected by the spawner via `AAI_GUEST_MODE`
(behavior selection, never a security boundary — capability is what the host
delivers):
  **agent mode** (deployed agents — see "Agent guests are servers") boots
  from files delivered at exec time and serves only the public session
  surfaces plus the token-gated `/manage/status` + `/manage/drain` pair
  (`harness-agent-mode.ts`); **studio mode** serves
  `/ws` (bearer-token host control channel — JSON-RPC
  `workspace/deploy` (Publish's in-guest `aai deploy`), `status`,
  `studio/session-init`; guest→host
  `studio/sync-workspace`, `studio/persist-chat` — bundle loading and tool
  trials are harness-internal now, driven by the in-guest coding agent,
  not RPC),
  `/session` (PUBLIC client voice sessions, connected directly by
  browsers — the embedded SDK runtime drives STT/LLM/TTS in-guest), and
  `/studio/chat` + `/studio/tools` (the studio coding agent's PUBLIC chat
  surface, bearer-gated by the broker-minted per-session chat token — see
  `packages/aai-studio-server/CLAUDE.md`), plus `POST /studio/session-init`,
  the HTTP twin of the `studio/session-init` RPC gated by the per-sandbox
  HOST token, for the replica that does not hold this guest's single control
  socket (see
  `packages/aai-studio-server/CLAUDE.md`, "One studio sandbox per project,
  fleet-wide").
  `harness.ts` (servers + dispatch), `harness-agent-mode.ts` (agent-server
  boot, manage surface, idle/drain lifecycle), `trial.ts` (run_code
  executor + one-shot tool trials), `harness-rpc.ts` (guest→host request
  proxy), `studio-session-init.ts` (the HTTP install route + the guest's own
  (scope, project) identity pin), `studio-http.ts` (shared CORS + bounded
  body read for both `/studio/*` surfaces),
  `studio-chat.ts`/`studio-tools.ts`/`studio-edit.ts`/`studio-grep.ts`
  (the in-guest coding agent), `studio-build.ts` (in-guest workspace
  builds through the aai CLI bundlers), `studio-publish.ts` (Publish =
  the literal `aai deploy` CLI, run in-sandbox), `limits.ts` (constants —
  import-free except the workspace caps, re-exported from
  `@alexkroman1/aai/workspace-files` so the CLI's push, this sync and
  the platform's validation cannot disagree). The harness embeds NO agent
  runtime — every worker
  bundle ships its own (`__aaiCreateRuntime`, see "User-shipped runtime"
  below) — and tsdown bundles the harness (server shell + studio coding
  agent) into the single `dist/harness.mjs` the server resolves via
  `aai-guest/harness` and bakes into the snapshot image, keeping the build
  toolchain (`@alexkroman1/aai-cli`, the client-build plugins) EXTERNAL:
  it resolves at runtime from the node_modules next to the harness

**Error text comes from the SDK's `errorMessage`, never a local copy.** This
package had three implementations of it at once: a local `errMsg` in
`harness-rpc.ts` used at 33 sites, a hand-inlined ternary in
`studio-session-init.ts`, and — in `harness-crash-guards.ts` — the real
`errorMessage` from `@alexkroman1/aai`, imported under an alias. The local
one was strictly weaker: `errorMessage` also unwraps a non-`Error` object
carrying a string `message`, which is exactly what a thrown value looks like
after crossing this module's own JSON-RPC boundary, and `errMsg` rendered
those as `[object Object]`. One name, one import, and the behaviour is
covered once in `sdk/utils.test.ts`.

**The two files a Publish writes for the CLI come from the CLI'S OWN
writers** (`@alexkroman1/aai-cli/project-config` — `writeConfigHome` and
`updateProjectConfig`). `studio-publish.ts` used to `JSON.stringify` both the
dir-local config home and `.aai/project.json`, so their shapes agreed with the
schemas the CLI parses them back with only by coincidence — and the two
properties that matter are not visible in the JSON at all: the config home
holds the caller's API key and is written **0600 through an atomic rename**
(which TIGHTENS an older world-readable file rather than leaving it), and the
project pin is **merged, never replaced** (`.aai/project.json` also carries the
studio link fields, which a whole-document write drops). Reaching for the
toolchain is safe on this path specifically because `resolveCliEntry()` runs
first and has already failed the publish cleanly if it is not there — so the
dynamic import is deliberately AFTER it. Anything else this package writes for
the CLI to read belongs in that subpath too, not in a `JSON.stringify` here.

## Dev/prod parity

**The guest IS the dev server — and the runtime IS the user's.** The
harness wraps the same `createServer` (`aai/host/server.ts`) that `aai dev`
runs — health, `client-config`, and `/websocket` sessions — adding (per
mode) the `/manage/*` request hook or the `/ws` control channel, plus a
lazy runtime facade (`lazyRuntime` in `aai-guest/harness.ts`: the runtime
is built on the first session — a `test_agent` load carries an empty env).
The runtime itself comes from the BUNDLE (see "User-shipped runtime"
below), so dev and prod run the identical SDK version: the one in the
user's lockfile. In agent mode the bundle arrives at exec time — a file or
a signed URL, hash-verified either way (`harness-bundle-source.ts`); the
studio's test_agent loads its build in-guest through the same loader.
There is **no deploy-time inspection mode**: the platform stores no agent
config and never asks a bundle to describe itself (see "The platform stores
no agent config" in `packages/aai-server/CLAUDE.md`). Either way it
loads from a temp-file `file:` URL.

## User-shipped runtime

The worker bundle ships its own SDK runtime. `buildWorker`'s generated
wrapper entry exports `__aaiCreateRuntime` — a factory over the *user's
installed* SDK's `createRuntime`, bundled in with the provider SDKs (an SSR
Vite build: server resolve conditions, `node:` builtins external, dynamic
imports inlined via `codeSplitting: false`) — and the harness builds every
session through it. The harness embeds no runtime at all, so **platform SDK
drift can never break a deployed agent**: it runs exactly the runtime
version it was built and tested against, the same one `aai dev` ran.

- The harness↔bundle contract is deliberately tiny (`CreateGuestRuntime` in
  `aai-guest/harness-types.ts`): `{ env, db?, runCode? }` in,
  `{ startSession, shutdown }` out. Keep it that way — everything else
  (provider resolution, tool dispatch, session state) is the bundle's SDK's
  business, on the bundle's SDK's version.
- A bundle without the factory is rejected at load ("rebuild with a
  current @alexkroman1/aai-cli"); there is no embedded-runtime fallback.
- Deploy artifacts are therefore ~8 MB minified before user code
  (`MAX_WORKER_SIZE` is 30 MB), and `evalWorkerBundle` imports workers via
  a temp `file:` URL — the bundled runtime's CJS interop calls
  `createRequire(import.meta.url)`, which rejects `data:` URLs.
- The dev server passes `runtime: false` to `buildWorker`: it builds its
  runtime in-process from the same installed SDK anyway, and inlining the
  runtime on every watch rebuild would make reloads multi-second.
  `aai build` / `aai deploy` / studio builds always ship it.

**Known remaining asymmetries**, none closable without larger work:

| Divergence | Direction | Why it stands |
| --- | --- | --- |
| Modal memory/CPU limits (`SANDBOX_MEMORY_LIMIT_MB`, `SANDBOX_CPU_LIMIT`) | works in dev, fails in prod | `aai dev` runs tools in the host process with no caps; a memory-hungry tool OOMs only when deployed. |
| `run_code` | fails in dev, works in prod | The host-side guard refuses rather than evaluating in-process. Fail-closed, so harmless. |
| `withHostCredentialFallback` (`providers/host-env.ts`) | works in dev, fails in prod | Deliberate ergonomic: an exported `ANTHROPIC_API_KEY` should work for `aai dev`. Two guards keep the cliff visible: the dev server warns when a required key resolved from the shell only (`agentEnvWarnings` in `_dev-server.ts` — it won't survive `aai deploy`, which uploads `.env`), and `aai deploy` preflights required credentials against the env it is about to upload (`aai-cli/_preflight.ts`), so the gap surfaces as a deploy-time warning naming the key rather than as an auth error at first session. It WARNS rather than rejects — the CLI cannot see secrets already stored server-side. |
| `ctx.db` backing (BYO `DATABASE_URL` in dev vs platform-provisioned schema+role) | prod is stricter | Dev connects wherever the developer points it; prod pins search_path + statement_timeout on a per-app role. |
| Platform sandboxes need Modal credentials in production only | prod is stricter | `aai dev` runs tools in-process; the platform spawns real Modal sandboxes in production (`MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`), and an isolation-free child process in local dev — see `packages/aai-server/CLAUDE.md`, "Modal sandbox notes". |

## Agent guests are servers (no control channel)

DEPLOYED AGENTS spawn as servers (`spawnAgentServer` in sandbox-vm.ts;
guest side in `aai-guest/harness-agent-mode.ts`). The whole
platform↔deployed-agent contract, frozen per deploy by the harness image
pin and versioned by `GUEST_CONTRACT_VERSION` (additive changes only):

- **Boot**: the spawner writes the agent env as a FILE into the fresh sandbox
  (`sb.filesystem.writeText` on Modal, a scratch dir on the subprocess
  backend), then execs the harness with `AAI_GUEST_MODE=agent` + the artifact
  locations + the bundle's sha-256. The BUNDLE arrives one of two ways and the
  spawner picks by naming one env var or the other — `AAI_BUNDLE_PATH` for a
  file written the same way, or **`AAI_BUNDLE_URL` for a time-boxed signed
  Storage URL the guest fetches itself**, which is production's path and keeps
  ~8 MB from crossing the platform twice per cold spawn (see
  `packages/aai-server/CLAUDE.md`, "The guest fetches its own bundle"). The
  guest hash-verifies the bundle either way against `AAI_BUNDLE_SHA256` — the
  agents row's own record of what the deploy published — so it trusts the HASH
  and never the transport, and a mismatch is a hard boot failure rather than a
  silently different agent. It then loads the bundle BEFORE listening, and
  scrubs the env file. The two shapes are mutually exclusive on the wire on
  purpose: there is no precedence rule for either side to get wrong, and no way
  to point a guest at a path nobody wrote.

  Readiness is the guest's public `/health` answering 200 —
  polled by the host, raced against guest-process exit so a boot crash
  fails the spawn immediately with the guest's stderr in the host log
  (relayed from the moment the process exists — see `startGuestLogging`;
  draining only once the guest was READY discarded exactly the output that
  explains a boot failure).

  **How long a guest may take to boot and how long a CLIENT waits for it are
  separate budgets.** They were one number, so an agent whose top-level code
  blocks — never ready — hung every broker call for the full
  `AGENT_HEALTH_TIMEOUT_MS` (120s) before its 503, permanently. The broker
  caps its own wait at `BROKER_READY_TIMEOUT_MS` (20s, env overridable; 0
  waits for the whole boot budget) and answers 503 while the boot CONTINUES:
  the sandbox is already attached to its slot and reports `alive()` while
  pending, so the next call joins the SAME readiness promise instead of
  spawning a second sandbox. Tripping it on a healthy-but-slow boot costs one
  client reconnect, not a failure — `session-core.ts` re-brokers per attempt
  and only an ANSWERED lookup latches anything.
- **Ongoing surface**: `GET /manage/status` (live session count +
  draining + contractVersion — an operator/debugging probe; nothing
  host-side gates on it anymore) and
  `POST /manage/drain` (`?deadlineMs=` carries the retire budget the guest
  enforces itself), both gated by the per-sandbox bearer
  from the exec env. Nothing else — no WebSocket, no RPC, no host
  connection. The guest's public `/client-config` doubles as the broker's
  name/greeting source (proxied — see `packages/aai/CLAUDE.md`,
  "Pre-connection client config").
- **Lifecycle is guest-owned — the host runs NO idle machinery**: the agent
  guest self-exits after `AGENT_IDLE_EXIT_MS` (5 min; override by setting
  `AAI_GUEST_IDLE_EXIT_MS` on the SERVER, which `agentBootEnv` forwards into
  the guest's exec env — a guest reads only what it is handed at exec, so
  setting it on the platform process is what reaches BOTH backends) with
  zero sessions —
  this IS idle reclamation, not a backstop (the host's per-slot idle timers
  were deleted); the exit surfaces host-side as `onSandboxLost`, which
  detaches the slot, and the next broker call rebuilds it. A drained guest
  refuses new direct-dial sessions (close 1013 → the client re-brokers) and
  exits the moment it empties or at its drain deadline.
- **Redeploys hand over BLUE-GREEN** (`handoverSlot` in
  sandbox-resolve.ts): the agents-row change event boots the NEW deploy's
  sandbox and waits for its readiness before detaching the old one, so a
  redeploy never leaves an empty slot — the next caller lands warm while
  the old sandbox drains its calls in the background. A replacement that
  fails to boot retires the old resident anyway (an empty slot keeps the
  failure visible on the next broker call; silently serving superseded
  code would not).
