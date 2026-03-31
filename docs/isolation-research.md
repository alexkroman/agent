# Isolation Architecture Research

Research into alternatives for the current `secure-exec` V8 isolate sandbox
used in `aai-server`. Conducted March 2026.

## Current Architecture

The platform runs untrusted agent code in `secure-exec` V8 isolates. The
**host process** (Node.js on Fly.io) owns the long-lived WebSocket
connections, STT/TTS integration (AssemblyAI S2S), and LLM orchestration.
The **sandbox** only handles tool execution and hook invocation via RPC.

```
Browser <--WebSocket--> Host (Node.js / Fly.io)
                            |
                            |-- STT/TTS/LLM via AssemblyAI S2S
                            |
                            |-- RPC (HTTP POST localhost) -->  Sandbox (secure-exec V8 isolate)
                                                                  |-- Tool execution
                                                                  |-- Hook invocation
                                                                  |-- KV via http://kv.internal
```

### Current isolation infrastructure (~1,500 lines)

| File | Lines | Purpose |
|------|-------|---------|
| `sandbox.ts` | ~382 | V8 isolate orchestration, permissions, RPC client |
| `_harness-runtime.ts` | ~327 | RPC server inside isolate (tool/hook dispatch) |
| `sandbox-slots.ts` | ~212 | Lifecycle management, dual-lock, idle eviction |
| `sandbox-network.ts` | ~175 | Virtual hosts (kv.internal, host.internal) |
| `_bundler.ts` | ~137 | Vite build with Zod externalization for isolate |
| `_run-code.ts` | ~100 | `run_code` tool sandbox (node:vm) |
| `_ssrf.ts` | ~69 | SSRF protection (DNS, bogon, redirect chains) |
| `credentials.ts` | ~63 | AES-256-GCM secret encryption at rest |
| `isolate/tsconfig.json` | config | Compile-time enforcement (no @types/node) |

### Key pain points

1. **RPC bridge complexity** -- Embedded HTTP server in isolate with token
   auth, Zod validation, body size limits, timeout management.
2. **Zod shim fragility** -- Bundler externalizes Zod because its JIT uses
   `Function()` (blocked in isolate). 44-line shim proxies all schema
   methods; breaks if agent code introspects schemas.
3. **Compilation zone split** -- `isolate/` vs `host/` directories with
   restricted tsconfig. `_harness-runtime.ts` must use `import type` only
   from workspace packages. Transitive npm deps that touch Node APIs break
   silently.
4. **Boot timeout** -- 15s hardcoded timeout for isolate to announce its
   HTTP port. Fragile under load.
5. **No observability** -- No metrics for isolate health, spawn time, slot
   utilization, or eviction frequency.

---

## Options Evaluated

### 1. Deno Sandbox (Firecracker microVMs)

**What it is:** Lightweight Linux microVMs on Deno Deploy, controllable via
`@deno/sandbox` SDK. Same tech as AWS Lambda (Firecracker). Sub-second boot.

**What it would replace:**
- `sandbox.ts`, `_harness-runtime.ts`, `sandbox-network.ts` (RPC bridge)
- `credentials.ts` (secrets never enter VM -- injected at network proxy)
- `_ssrf.ts` (replaced by `allowNet` whitelist)
- `isolate/tsconfig.json` compilation zone (Deno runs standard JS/TS)
- Zod shim in bundler (no `Function()` restriction)

**What it would add:**
- Deno KV (replaces unstorage + S3 for agent data)
- Deno Queues (background task processing)
- Deno.cron (scheduled tasks)
- BroadcastChannel (cross-instance cache invalidation)
- Built-in observability (logs, traces, metrics)

**Critical limitation: WebSocket connections.**
Deno Deploy edge functions are ephemeral (minutes to ~1 hour). Voice sessions
need persistent WebSocket connections for real-time audio streaming. The host
orchestrator cannot run on Deno Deploy.

**Viable architecture:**
- Deno runtime on Fly.io (or similar) for the WebSocket orchestrator
- `@deno/sandbox` SDK to spin up microVMs for agent code execution
- Deno KV for agent storage (isolated per agent via separate databases)

**Trade-offs:**
- Vendor dependency on Deno's managed infrastructure
- Runtime change from Node.js to Deno for the host process
- Self-hosted users would need Deno instead of Node
- Deno KV data residency is US-only (us-east4)
- Network round-trip to Deno cloud for every tool call / hook invocation

**Verdict:** Strong option if willing to accept Deno as a runtime dependency
and the network latency for sandbox RPC calls. Eliminates ~1,500 lines of
isolation code. Best if Deno adds a "local sandbox" mode that avoids the
cloud round-trip.

---

### 2. Deno Deploy + Subhosting

**What it is:** Run the entire platform on Deno's edge, with Subhosting for
multi-tenant agent execution.

**Critical limitation:** Same WebSocket problem as above. Deno Deploy
functions are ephemeral and can die mid-session. Real-time audio streaming
requires long-lived processes.

**Verdict:** Not viable as a full replacement. Could work for non-WebSocket
routes (deploy, delete, secrets, health, static assets) in a hybrid setup,
but adds operational complexity.

---

### 3. Cloudflare Workers / workerd (self-hosted)

**What it is:** Cloudflare's open-source JS/Wasm runtime using V8 isolates.

**Critical limitation:** Cloudflare themselves state: *"workerd on its own
does not contain suitable defense-in-depth against the possibility of
implementation bugs. When using workerd to run possibly-malicious code, you
must run it inside an appropriate secure sandbox, such as a virtual machine."*

**Trade-offs:**
- Requires wrapping in a VM for security (negates the lightweight benefit)
- Different programming model (Workers API, not Node.js)
- Agents would need to target Web Workers API
- Heavy C++ runtime to embed

**Verdict:** Not suitable for self-hosted untrusted code execution without
additional VM wrapping. Designed for Cloudflare's multi-layer infrastructure,
not standalone use.

---

### 4. `@cloudflare/sandbox` SDK

**What it is:** Run containers on Cloudflare's edge network, controllable
via SDK from any environment.

**Critical limitation:** Network round-trip from Fly.io to Cloudflare edge
on every tool call during real-time voice sessions. Unacceptable latency.

**Verdict:** Wrong architecture for RPC-heavy, latency-sensitive workloads
running on a different cloud provider.

---

### 5. `isolated-vm`

**What it is:** Node.js addon exposing V8's Isolate interface. Maintenance
mode (bug fixes only).

**Trade-offs:**
- No npm compatibility (agents can't use npm packages in tools)
- No network adapter (would rebuild kv.internal bridge manually)
- No filesystem virtualization
- Leaking any isolated-vm object to untrusted code = full escape
- Requires C++ compiler; `--no-node-snapshot` on Node 20+

**Verdict:** Would require rebuilding most of what `secure-exec` provides.
Strictly worse for this use case.

---

### 6. `v8-sandbox` (Fulcrum)

**What it is:** V8 context in a separate Node.js process, JSON-only IPC.

**Trade-offs:**
- Separate process = better isolation but IPC latency on every call
- JSON-only communication (no structured clone)
- No npm compatibility (pure V8 context)
- No filesystem or network virtualization

**Verdict:** Stronger process isolation but loses npm compatibility and adds
latency. Would require rebuilding all bridging infrastructure.

---

### 7. `@anthropic-ai/sandbox-runtime`

**What it is:** OS-level sandboxing (Linux namespaces, seccomp) for whole
processes. Used by Claude Code.

**Trade-offs:**
- Process-level sandboxing, not in-process JS isolation
- Designed for CLI tools / full programs, not agent tool functions
- Had CVE-2025-66479 (empty allowedDomains left network wide open)

**Verdict:** Different use case. Not designed for embedding JS execution
within a host process.

---

## Recommendation

**Stay with `secure-exec`.** It is purpose-built for this architecture:

- In-process V8 isolates with npm compatibility
- Deny-by-default permissions (fs, network, env, child_process)
- Network adapter for virtual hosts (kv.internal bridge)
- ~3.4 MB per isolate (210 concurrent on 1 GB server)
- Actively developed: warm isolate pool and V8 process isolation landing
  in March 2026 releases

No alternative matches all requirements without significant trade-offs:

| Requirement | secure-exec | Deno Sandbox | isolated-vm | v8-sandbox | workerd |
|---|---|---|---|---|---|
| In-process (no network hop) | Yes | No (cloud) | Yes | No (IPC) | Yes |
| npm compatibility | Yes | Yes | No | No | Partial |
| Deny-by-default permissions | Yes | Yes | Manual | Manual | Yes |
| Network virtualization | Yes | Built-in | No | No | Yes |
| Filesystem virtualization | Yes | Built-in | No | No | Yes |
| Active development | Yes | Yes | Maintenance | Yes | Yes |
| No VM wrapper needed | Yes | N/A | Yes | Yes | No |

### Improvement areas (with secure-exec)

1. **Adopt warm isolate pool** (landing now) to eliminate the 15s boot
   timeout pain point.
2. **Adopt V8 process isolation** (landing now) for defense-in-depth
   against V8 exploits, without changing the API.
3. **Simplify the RPC bridge** -- work with Rivet on a first-class
   "function call" primitive to replace the embedded HTTP server in
   `_harness-runtime.ts`.
4. **Add observability** -- instrument isolate lifecycle (spawn time,
   tool call latency, memory usage, eviction frequency).
5. **Revisit Zod shim** -- explore whether warm pool + process isolation
   allows using real Zod inside isolates.

### Future re-evaluation triggers

- Deno Sandbox adds a **local mode** (no cloud round-trip) -- would
  eliminate the latency concern and make it a strong contender.
- secure-exec development stalls or Rivet changes direction.
- Platform moves off Fly.io to a Deno-native or Cloudflare-native hosting
  model.
- WebSocket requirements change (e.g., move to HTTP streaming) making
  Deno Deploy viable for the orchestrator.

---

## Sources

- [secure-exec (Rivet)](https://github.com/rivet-dev/secure-exec)
- [secure-exec releases](https://github.com/rivet-dev/secure-exec/releases)
- [Deno Sandbox](https://docs.deno.com/sandbox/)
- [Deno Deploy](https://docs.deno.com/deploy/)
- [Deno KV](https://deno.com/kv/)
- [Deno Subhosting](https://deno.com/subhosting)
- [Cloudflare workerd](https://github.com/cloudflare/workerd)
- [Cloudflare workerd security model](https://developers.cloudflare.com/workers/reference/security-model/)
- [@cloudflare/sandbox](https://www.npmjs.com/package/@cloudflare/sandbox)
- [Cloudflare Dynamic Workers](https://blog.cloudflare.com/dynamic-workers/)
- [isolated-vm](https://github.com/laverdet/isolated-vm)
- [v8-sandbox](https://github.com/fulcrumapp/v8-sandbox)
- [@anthropic-ai/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
- [CVE-2025-66479](https://oddguan.com/blog/anthropic-sandbox-cve-2025-66479/)
- [Deno Deploy WebSocket limitations](https://questions.deno.com/m/1338457821183737887)
- [Simon Willison's JS Sandboxing Research](https://github.com/simonw/research/tree/main/javascript-sandboxing-research)
