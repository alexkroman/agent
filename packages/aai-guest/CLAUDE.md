# aai-guest — the guest sandbox harness (private)

The Node entrypoint that runs the complete agent inside each Modal Sandbox,
built into one self-contained `dist/harness.mjs`. It never imports server
code and the server never imports guest source — that hard boundary is why
this is its own package. Repo-wide conventions live in the root
[CLAUDE.md](../../CLAUDE.md); the host side of every contract below is in
[aai-server](../aai-server/CLAUDE.md).

- `packages/aai-guest/` — its own private workspace package: the Node guest
  entry point (runs inside a Modal Sandbox) that runs the COMPLETE agent.
  ONE BINARY, TWO MODES, selected by the spawner via `AAI_GUEST_MODE`
  (behavior selection, never a security boundary — capability is what the
  host delivers):
  **agent mode** (deployed agents — see "Agent guests are servers") boots
  from files delivered at exec time and serves only the public session
  surfaces plus the token-gated `/manage/status` + `/manage/drain` pair
  (`harness-agent-mode.ts`); a third ONE-SHOT **describe mode**
  (`AAI_DESCRIBE_BUNDLE_PATH`) imports a bundle and prints its
  self-described config as the last stdout line CARRYING THIS EXEC'S NONCE
  (`AAI_DESCRIBE_NONCE`; "last line" alone is not a defense — the bundle is
  imported into that process, so a `process.on("exit")` handler prints after
  the harness. The harness deletes the nonce from `process.env` before
  importing, so bundle code cannot read the value it would have to forge) —
  deploy-time config
  extraction with no server, no token, no channel; **studio mode** serves
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
  "Browser studio"), plus `POST /studio/session-init`, the HTTP twin of the
  `studio/session-init` RPC gated by the per-sandbox HOST token, for the
  replica that does not hold this guest's single control socket (see "One
  studio sandbox per project, fleet-wide").
  `harness.ts` (servers + dispatch), `harness-agent-mode.ts` (agent-server
  boot, manage surface, idle/drain lifecycle), `trial.ts` (run_code
  executor + one-shot tool trials), `harness-rpc.ts` (guest→host request
  proxy), `studio-session-init.ts` (the HTTP install route + the guest's own
  (scope, project) identity pin), `studio-http.ts` (shared CORS + bounded
  body read for both `/studio/*` surfaces),
  `studio-chat.ts`/`studio-tools.ts`/`studio-edit.ts`/`studio-grep.ts`
  (the in-guest coding agent), `studio-build.ts` (in-guest workspace
  builds through the aai CLI bundlers), `studio-publish.ts` (Publish =
  the literal `aai deploy` CLI, run in-sandbox), `limits.ts` (import-free constants
  mirroring the SDK's). The harness embeds NO agent runtime — every worker
  bundle ships its own (`__aaiCreateRuntime`, see "User-shipped runtime"
  below) — and tsdown bundles the harness (server shell + studio coding
  agent) into the single `dist/harness.mjs` the server resolves via
  `aai-guest/harness` and bakes into the snapshot image, keeping the build
  toolchain (`@alexkroman1/aai-cli`, the client-build plugins) EXTERNAL:
  it resolves at runtime from the node_modules next to the harness
### Agent guests are servers (no control channel)

DEPLOYED AGENTS spawn as servers (`spawnAgentServer` in sandbox-vm.ts;
guest side in `aai-guest/harness-agent-mode.ts`). The whole
platform↔deployed-agent contract, frozen per deploy by the harness image
pin and versioned by `GUEST_CONTRACT_VERSION` (additive changes only):

- **Boot**: the spawner writes the worker bundle and the agent env as
  FILES into the fresh sandbox (`sb.filesystem.writeText` on Modal, a
  scratch dir on the subprocess backend), then execs the harness with
  `AAI_GUEST_MODE=agent` + the artifact paths + the bundle's sha-256. The
  guest hash-verifies the bundle (a mismatch is a hard boot failure, never
  a silently different agent), loads it BEFORE listening, and scrubs the
  env file. Readiness is the guest's public `/health` answering 200 —
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
  name/greeting source (proxied — see "Pre-connection client config").
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
