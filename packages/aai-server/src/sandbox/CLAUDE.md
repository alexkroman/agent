---
summary: >-
  The backend-independent sandbox lifecycle: backend selection, the slot cache,
  the broker as the only routing point, one sandbox per slug fleet-wide, and
  the teardown-before-boot rule.
read_when: >-
  editing anything in `aai-server/src/sandbox/` — spawn, broker, resolve,
  slots, directory/peers, invalidation, retirement.
---

# packages/aai-server/src/sandbox — lifecycle and routing

The per-backend details (images, Modal, microsandbox traps, resources) are in
[`MODAL-CLAUDE.md`](../../MODAL-CLAUDE.md). One sandbox's lifecycle object is
`src/sandbox.ts`; deployed agents run as servers and the host holds no channel
to them (`packages/aai-guest/src/harness/CLAUDE.md`, "Agent guests are servers").

## Files

- `vm.ts` — `spawnAgentServer` (dispatch over the three backends), the
  studio-side `spawnWarmHarness` control channel, and `WorkerSource` (the
  signed bundle URL; see "The guest fetches its own bundle" in the package
  guide).
- `backend.ts` — selection: `SANDBOX_BACKEND` override, production → `modal`,
  `AAI_LOCAL_DEV=1` → `microsandbox`, `subprocess` opt-in only. The safe branch
  is the default: `backend.test.ts` asserts an empty env `{}` resolves to
  isolation. The boot log prints which backend and why.
- `slots.ts` — per-slug slot cache `{ slug, version?, sandbox? }`. A plain
  `Map`; `withSlugLock` is the exclusion (`SlotCache`'s doc). No idle
  machinery — the guest self-exits, and its exit drops the whole SLOT via
  `onSandboxLost`, not just its sandbox.
- `resolve.ts` — slot-based slug→sandbox resolution and
  `watchAgentInvalidation` (driven by the agents row's change stream).
- `broker.ts` — `brokerSessionUrl`: slug → public session URL with one failure
  taxonomy shared by `GET /:slug/client-config`, the `/:slug/websocket`
  upgrade, the workflow routes and the queue sweep. **The platform's ONLY
  routing point** — new callers broker through it.
- `directory.ts` / `peers.ts` — fleet-wide "is some replica already serving this
  deploy?" (below).
- `invalidate.ts` — deploy and delete move sandboxes via the agents row
  `version`; a secret change does not (apply it by redeploying). A mutation
  that changes a guest's environment without its code must bump the row
  (`AgentRows.touch`).

## A teardown may not depend on the boot it is tearing down

`createSandbox` returns synchronously with a pending `vmReady`, so the Modal
create, boot writes and readiness probe run OUTSIDE the broker's slug lock and
a DELETE can complete while a guest is still booting.

**Rule: a capability a TEARDOWN needs must never be published only on the
RESOLVED handle.** Both backends hand over a kill the moment the sandbox exists
(`BackendAgentSpawn.onSpawned`, whose doc carries the account) and `shutdown()`
falls back to it rather than waiting on `vmReady`. Note `28P01` (auth failed)
is also what a missing Postgres role reports, so a lifecycle race can read as a
credential bug.

## No warm pool

Every spawn boots from the content-addressed harness snapshot image, one code
path per backend. Do NOT reintroduce a host-managed pool; see
[`MODAL-CLAUDE.md`](../../MODAL-CLAUDE.md), "No warm pool".

## No horizontal sandbox scaling — one sandbox per slug, FLEET-WIDE

A slug has ONE resident sandbox; the broker (`resolveSandbox`) serves it or
rebuilds it. Per-slug scaling (session caps, overflow replicas) stays deleted;
if it ever returns, the guest-reported session count is the only honest load
signal and the broker the only routing point.

"One" is fleet-wide and **Modal enforces it** (`directory.ts`): Modal
load-balances every request independently, so per-replica slot caches alone
would spawn a guest per replica. The identity is the Modal sandbox **name**
`agent-<hash(slug)>-v<version>`: `sandboxes.create` throws `AlreadyExistsError`
when taken and `sandboxes.fromName` returns only a RUNNING sandbox, so a cold
broker routes to a peer's tunnel (sessions dial the guest directly, so a peer
URL serves as well as a local one). A name is released when the sandbox stops,
so it cannot hand out a dead peer. (microsandbox does not share this property —
see `MODAL-CLAUDE.md`.)

- **The name carries the deploy VERSION** — a blue-green `handoverSlot` has two
  live sandboxes for minutes, and the peer lookup is version-exact.
- **The peer route is gated on the agents row still existing** — a retiring
  sandbox of a deleted agent is still running. The same `getAgentVersion` read
  is both the gate and half the name.
- **Losing the name race routes to the winner** (`awaitBrokeredUrl`):
  `SandboxNameTakenError` sends the broker back to the directory, never into a
  retry spawn.

The directory is read at the broker, NOT subscribed to — a change stream would
be a second mechanism answering the same question.
