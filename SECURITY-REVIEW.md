# AAI Platform Security Review

**Date:** 2026-04-07
**Scope:** Full codebase — sandbox/isolate, SSRF/network, auth/credentials, input validation, dependencies
**Method:** Parallel agent-based review across 5 independent security domains

---

## Executive Summary

The AAI platform has a **strong security architecture** for the managed platform (aai-server), with multi-layered defense-in-depth: V8 isolates + secure-exec permissions + nsjail + seccomp. Credential separation, KV isolation, and network policies are well-implemented.

The **self-hosted mode** (`createServer()`) is significantly weaker — it lacks SSRF protection on built-in tools and the `run_code` tool's `node:vm` sandbox is escapable. These are the most critical findings.

**Findings by severity:**

| Severity | Count |
|----------|-------|
| CRITICAL | 1 |
| HIGH | 2 |
| MEDIUM | 9 |
| LOW | 7 |
| INFO | 4 |

---

## CRITICAL

### C1: `run_code` VM Sandbox Escape — Full RCE in Self-Hosted Mode

**Files:** `packages/aai/host/_run-code.ts:101-123`

The `run_code` built-in tool uses `node:vm` to sandbox user code but passes host-realm objects (functions and classes) directly into the VM context. Any host object's `.constructor` property provides access to the host `Function` constructor, enabling arbitrary code execution outside the sandbox.

An attacker who can influence LLM tool calls (via prompt injection or a malicious agent definition) can escape the sandbox via constructor chain traversal on any passed-in host object — accessing the host process, reading env vars (including `ASSEMBLYAI_API_KEY`), accessing the filesystem, and executing arbitrary system commands.

The existing test at `builtin-tools.test.ts:168` only tests in-context string constructor chains but NOT escape through host objects passed into the context.

**Note:** Platform mode (secure-exec V8 isolates) is NOT affected.

**CLAUDE.md incorrectly states** "Each invocation runs in a fresh `node:vm` context — isolated from the host process."

**Mitigation:**
1. **Immediate:** Disable `run_code` in self-hosted mode or add a prominent warning
2. **Short-term:** Use `vm.createContext` with `codeGeneration: { strings: false, wasm: false }`
3. **Long-term:** Use `isolated-vm` or secure-exec for `run_code` in self-hosted mode

---

## HIGH

### H1: Default Credential Encryption Key Is a Static Constant

**Files:** `packages/aai-server/constants.ts:36`, `packages/aai-server/index.ts:49-51`

When `KV_SCOPE_SECRET` is not set, the server derives the credential encryption key from the hard-coded string `"default-credential-key"`. All production deployments that fail to set this env var use the same AES-256-GCM key, making encrypted agent secrets decryptable by anyone who reads the source code.

**Mitigation:** Refuse to start the server in non-dev mode when `KV_SCOPE_SECRET` is unset. Add to `requireEnv()` alongside `BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, etc.

### H2: `ssrfSafeFetch` Exists But Is Never Wired to Self-Hosted Built-in Tools

**Files:** `packages/aai-server/ssrf.ts:59`, `packages/aai/host/builtin-tools.ts:82,120,195`

The `ssrfSafeFetch` function implements redirect-safe SSRF protection but is never called by production code. Built-in tools (`web_search`, `visit_webpage`, `fetch_json`) call `globalThis.fetch` directly with no SSRF protection in self-hosted mode. A comment claims "Network requests go through the host's fetch proxy (with SSRF protection)" but no such proxy is wired up.

An attacker who can influence LLM tool calls (via prompt injection) could hit `http://169.254.169.254/latest/meta-data/` or internal services.

**Platform mode** is protected by secure-exec's network adapter restricting to loopback/sidecar only.

**Mitigation:** Wire `ssrfSafeFetch` as the `fetchFn` for built-in tools in self-hosted mode.

---

## MEDIUM

### M1: DNS Rebinding TOCTOU Gap

**File:** `packages/aai-server/ssrf.ts:24-36,64`

`assertPublicUrl` resolves DNS and checks the IP, but the subsequent `fetch` performs its own resolution. An attacker's DNS with short TTL could return a public IP for validation, then `127.0.0.1` for the actual fetch.

**Mitigation:** Pin resolved IP and force `fetch` to use it (replace hostname with IP, set `Host` header).

### M2: No WebSocket Origin Validation

**File:** `packages/aai-server/orchestrator.ts:149-181`

WebSocket upgrades bypass Hono's middleware — no `Origin` header checking. Any webpage can establish WebSocket connections to agents.

**Mitigation:** Add Origin validation in the upgrade handler.

### M3: WebSocket Endpoint Has No Authentication

**File:** `packages/aai-server/orchestrator.ts:128-182`

The `/:slug/websocket` path requires no auth. Anyone who knows a slug can connect and interact with the agent. Slugs follow predictable `human-id` patterns.

**Mitigation:** Add optional auth token for WebSocket connections, or document this as intentional for public agents. Add per-slug connection limits.

### M4: No Rate Limiting on Auth Endpoints

**Files:** `packages/aai-server/middleware.ts`, `packages/aai-server/orchestrator.ts`

No rate limiting on `/deploy`, `/:slug/secret`, or any authenticated endpoint.

**Mitigation:** Add rate limiting middleware, at least on auth failure responses.

### M5: Harness Auth Bypass When Token Empty

**File:** `packages/aai-server/harness-runtime.ts:72-73,257-261`

`isAuthorized()` returns `true` when `HARNESS_AUTH_TOKEN_BUF` is null (token env var unset). While the normal flow always sets a token, misconfiguration would leave the RPC server unauthenticated.

**Mitigation:** Fail closed — return `false` when token is null.

### M6: Path Traversal to Sibling Directories in Static File Serving

**File:** `packages/aai/host/server.ts:62-67`

`filePath.startsWith(dir)` is vulnerable when `dir` doesn't end with a separator. `path.join("/var/www", "/../www-secret/file")` normalizes to `/var/www-secret/file`, which passes `startsWith("/var/www")`.

**Mitigation:** Use `filePath.startsWith(resolved + path.sep)`.

### M7: Self-Hosted KV Endpoint Has No Authentication

**File:** `packages/aai/host/server.ts:149-152`

The `/kv?key=<key>` endpoint on the self-hosted server has no auth. Any network client can read KV entries. (Platform server properly gates behind `ownerMw`.)

**Mitigation:** Add optional API key auth or remove the HTTP endpoint.

### M8: No HTTPS Enforcement for CLI API Key Transmission

**Files:** `packages/aai-cli/_agent.ts:15-35`, `packages/aai-cli/_api-client.ts`

The `--server` flag or config can point to any URL. No validation that non-localhost URLs use HTTPS.

**Mitigation:** Warn or block when sending credentials to non-HTTPS, non-localhost URLs.

### M9: Mutable Template Branch Reference in `aai init`

**File:** `packages/aai-cli/_templates.ts:11`

Templates fetched from `github:alexkroman/agent#main` — a mutable branch reference. If the repo is compromised or force-pushed, every `aai init` gets malicious code.

**Mitigation:** Pin to commit SHA or bundle templates in the npm package.

---

## LOW

### L1: Decimal/Octal IP Encoding Not Explicitly Blocked
**File:** `packages/aai-server/ssrf.ts:20-21` — `isLiteralIp` regex doesn't match `2130706433` or `0177.0.0.1`. Mitigated by DNS resolution check but edge cases possible.

### L2: Non-Timing-Safe Hash Comparison in Deploy
**File:** `packages/aai-server/deploy.ts:24,58` — Uses `Array.includes()` for hash comparison instead of `timingSafeCompare`. Low risk since these are SHA-256 hashes and auth is already validated.

### L3: `pnpm dlx` Fetches Unpinned Package at Runtime
**File:** `package.json:25` — `sherif@1.11.1` downloaded via `pnpm dlx` without lockfile integrity. Move to devDependency.

### L4: CSP Allows `unsafe-eval`
**File:** `packages/aai/isolate/constants.ts:73-78` — Weakens XSS protection. Consider removing for production builds.

### L5: Client-Supplied Session ID Used Without Validation
**File:** `packages/aai/host/ws-handler.ts:152` — No format/length validation on `?sessionId=`. Could enable log injection or memory pollution.

### L6: `queueMicrotask` CPU DoS in run_code Sandbox
**File:** `packages/aai/host/_run-code.ts:122` — Infinite microtask loop blocks event loop, preventing timeout timer from firing.

### L7: Self-Hosted Server Has No WebSocket Connection Limits
**File:** `packages/aai/host/server.ts:180-199` — Unlike platform (which has `MAX_CONNECTIONS`), self-hosted accepts unlimited connections.

---

## INFO / POSITIVE FINDINGS

### Positive: Platform Sandbox Isolation Is Excellent
Multi-layered: V8 isolate permissions (fs read-only, network sidecar-only, no child processes, env allowlist) + nsjail (PID/network/mount/user namespaces, seccomp, cgroups) + per-sandbox auth tokens + ephemeral sidecar ports.

### Positive: Credential Separation Well-Implemented
`SandboxOptions` structurally separates `apiKey` (host-only) from `agentEnv` (isolate). `ASSEMBLYAI_API_KEY` explicitly destructured out before reaching isolate. AES-256-GCM with random IVs and slug-bound AAD.

### Positive: XSS Protection Is Solid
Preact auto-escapes all JSX expressions. No unsafe innerHTML usage found anywhere. `escapeHtml()` covers all 5 HTML special characters. Protocol messages validated with Zod discriminated unions on both client and server.

### Positive: Cross-Agent KV Isolation Correct
KV keys prefixed with `agents/${slug}/kv` via `unstorage` `prefixStorage`. Slug validation prevents injection. Integration tests verify cross-agent isolation.

---

## Documentation Issues

CLAUDE.md references test files that don't exist:
- `pentest.test.ts`
- `run-code-sandbox.test.ts`
- `security-boundary.test.ts`
- `trust-boundary-validation.test.ts`

Their coverage appears partially provided by `builtin-tools.test.ts` and `orchestrator-security.test.ts`. Update CLAUDE.md or create the files.

Also: CLAUDE.md mentions "Scope tokens are HS256 JWTs with 1-hour expiry" but no JWT implementation was found. The auth system uses API key Bearer tokens with SHA-256 hashing.

---

## Recommended Priority Order

1. **C1** — Disable or fix `run_code` in self-hosted mode (CRITICAL RCE)
2. **H1** — Require `KV_SCOPE_SECRET` in production
3. **H2** — Wire SSRF protection to self-hosted built-in tools
4. **M5** — Fail closed on empty harness auth token
5. **M6** — Fix path traversal in static file serving
6. **M7** — Add auth to self-hosted KV endpoint
7. **M1-M4** — Network/auth hardening (DNS rebinding, Origin validation, rate limiting, WebSocket auth)
8. **M8-M9** — CLI/supply chain (HTTPS enforcement, template pinning)
