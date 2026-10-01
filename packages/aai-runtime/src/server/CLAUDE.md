---
summary: >-
  The server: `createAgentServer` as the front door — self-hosted workflows,
  serverless hosts, and what it forwards
read_when: >-
  editing anything under `src/server/`
---

# aai-runtime `server/`

Package-wide rules are in [`../../CLAUDE.md`](../../CLAUDE.md); the flat
`src/` modules' in [`../CLAUDE.md`](../CLAUDE.md). Outside this directory,
import its `index.ts` only (`guard-invariants` rule 37).

## `createAgentServer` is the front door

Three servers, picked by what the caller HAS: an agent definition →
`createAgentServer`; no agent, callers bring theirs → `createHostServer`; a
runtime built elsewhere or later (the guest harness, `aai dev`) →
`createServerForRuntime`, the layer the other two wrap. `createRuntimeServer` is
its deprecated old name — and stays the `GuestHost` FIELD name
(`guest-host.ts`), which shipped harnesses read across SDK versions.

### Self-hosted durable workflows: there is no world to start

The replay engine executes a run in THIS process off the agent's own
`workflows`. What `createAgentServer` owes is:

- **`publishWorkflowStepEnv()` at CONSTRUCTION**, only when the agent declares
  workflows (it writes a module-global, so publishing unconditionally leaks one
  test's env into the next; `unstubEnvs` only undoes `vi.stubEnv`). It
  publishes the AGENT env, not `providerEnv`, so a step sees exactly what `.env`
  declares. Construction, not `listen()`, because a host that binds
  `AgentServer.node` itself never calls `listen()`.
- **The delivery door**: `handleWorkflowRequest` is composed into
  `createServerForRuntime`'s `request` hook, wired identically to `aai dev` and the
  harness, with no `allowRemote` — so `POST /workflow-queue` answers 401 (no
  platform queue to vouch for it; in-process timers deliver).
- **A test must boot a workflow through this door** — `aai-cli`'s
  `e2e.test.ts` and the `pack + build + boot` subset do.
- The scaffold's `server.mjs` promises `PUBLIC_URL` and `DATABASE_URL`
  forwarding; `ensureWorkflowJournalSchema` is on the public barrel for the
  same reason (see "The tables come WITH the database" in
  `../workflow/journal/backends/postgres.ts`).
- Host mode (`createHostServer`) wires no workflows: its caller-supplied
  agents declare none.

### A server is HANDED to a serverless host, never started by one

`AgentServer.node` is the wired `node:http` server, because a serverless
platform (Vercel's Node runtime) wants `export default <http.Server>` and binds
the socket itself.

- **`port` is asked of the server, not latched by `listen()`**, and `close()`
  gates on `httpServer.listening`, so a socket bound through `node` is really
  released.
- **Anything `listen()` does that is not the BIND is a bug** — it runs in dev
  and silently not in production. `listen()` is the bind plus the boot line.
- **A serverless host gets no WebSocket** (`/websocket`, `/phone` unreachable);
  the HTTP surface is unaffected, which is all a `mode: "workflow-app"` app needs.
- **`server.mjs` still calls `listen()`**: `npm start` owns its lifecycle
  (`PORT`, boot line, signal handlers). A serverless deployment is a second,
  tiny entry module, not a mode of that one.

### `createAgentServer` forwards what only it can

An option the front door does not carry is unreachable, because dropping to
`createRuntime` + `createServerForRuntime` means restating every derived field by
hand. So:

- `page` and `telephony` are read off the AGENT (`telephony` defaults to no
  carrier), with an explicit field still winning; `name` and `greeting` are
  derived.
- **`env` is forwarded minus the host gate**, through `agentServerEnv`
  (`env.ts`, shared with the guest). `createServerForRuntime` reads
  `AAI_WORKFLOW_API_TOKEN` (closes `/workflows/*`),
  `AAI_SESSION_EVENTS_TOKEN`, and `DATABASE_URL` (where an upload's record
  lives) from it; the host-mode key is excluded because `?host=1` would run a
  caller's agent on the operator's credentials. "Belongs to the other door" is
  not a safe reason to drop an option.
- **`agent-server-forwarding.ts` is the enforcement**: every `RuntimeOptions`
  member is on `AgentServerOptions` or on `UnforwardedRuntimeOption` with a
  reason. `ForwardingGap`, `StaleExcuse`, `RedundantExcuse` and `TypeDrift`
  must be `never`; a violation fails `tsc` and the build (the spec beside it is
  type-level and cannot fail on its own).
- **A forwarding spec must take the door a caller takes**, not call
  `createServerForRuntime` directly.
- Reasons for each unforwarded member (sandbox seams, `stt`/`llm`/`tts`, two
  tuning numbers) are at the deny-list entry. Forward one when somebody needs
  it — `runCode` was, for `AAI_RUN_CODE=deno` (`packages/aai-cli/CLAUDE.md`).
