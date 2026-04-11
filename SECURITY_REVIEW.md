# Security Review & Plan

**Date**: 2026-04-11
**Scope**: Full codebase security audit of the AAI voice agent development kit
**Packages reviewed**: `aai`, `aai-cli`, `aai-server`, `aai-ui`, `aai-templates`

---

## Executive Summary

The AAI codebase demonstrates **strong security posture** overall. The defense-in-depth architecture -- gVisor sandboxing, Deno permission model, SSRF protection with DNS pinning, AES-256-GCM credential encryption, and consistent Zod validation at trust boundaries -- is well-designed and thoroughly tested.

**No critical exploitable vulnerabilities were found.** Several medium and low severity items are documented below with recommended remediation actions.

### Risk Summary

| Severity | Count | Description |
|----------|-------|-------------|
| Critical | 0 | - |
| High | 1 | NDJSON transport lacks schema validation on guest responses |
| Medium | 4 | node:vm escape risk, cgroup delegation, session state leak, WebSocket origin |
| Low | 6 | Static HKDF salt, curl\|bash in Dockerfiles, flyctl @master pin, etc. |
| Informational | 4 | Prompt injection (inherent to LLM), KV rate limiting, etc. |

---

## 1. Sandbox & gVisor Isolation

### 1.1 gVisor Configuration -- STRONG

The gVisor sandbox (`packages/aai-server/gvisor.ts`) provides excellent isolation:

- **Network**: `--network=none` blocks all network access (line 87)
- **Filesystem**: Read-only host mount with tmpfs overlay (writes to memory only)
- **Environment**: Empty `env: {}` -- secrets delivered over NDJSON RPC, not process.env (line 103-104)
- **Working directory**: `/tmp` (line 92), not host directory
- **Code delivery**: Agent code injected via NDJSON, not disk

### 1.2 NDJSON Transport -- HIGH RISK

**Finding**: Guest responses are not schema-validated on the host side.

- **Location**: `packages/aai-server/ndjson-transport.ts:104` -- `JSON.parse(line)` without Zod validation
- **Location**: `packages/aai-server/sandbox.ts:95` -- `return (response?.result ?? "") as string` with no schema check
- **Impact**: A compromised guest could return malformed responses that violate the RPC contract. While the guest cannot inject host commands (NDJSON is request-response), unvalidated data flowing into host logic could cause unexpected behavior.
- **Mitigating factor**: KV bridge responses now use Zod validation (per CHANGELOG). Tool execution responses do not.
- **Recommendation**: Add Zod schema validation to all guest-to-host response paths, matching the KV bridge pattern.

### 1.3 node:vm `run_code` Tool -- MEDIUM RISK

**Location**: `packages/aai/host/_run-code.ts`

The implementation is well-hardened:
- `codeGeneration: { strings: false, wasm: false }` blocks `new Function()` (line 190)
- `neutralizeConstructor()` prevents `.constructor.constructor` chain escape (lines 45-74)
- Whitelist-only globals (console, timers, URL, TextEncoder, etc.)
- 5-second timeout (line 200)

**Residual risk**: `node:vm` is [documented by Node.js as not a security mechanism](https://nodejs.org/api/vm.html#vm-executing-javascript). New escape vectors are discovered periodically in Node.js releases. The gVisor sandbox provides the actual security boundary.

**Recommendation**: Pin Node.js versions in production and monitor Node.js security advisories for vm module CVEs. Consider documenting that `run_code` relies on gVisor as the true security boundary.

### 1.4 Resource Limits -- MEDIUM RISK

**Location**: `packages/aai-server/gvisor.ts:88`

`--ignore-cgroups` means gVisor does not enforce memory/PID limits itself. Resource exhaustion prevention is fully delegated to the container orchestrator (Fly.io/Docker).

**Location**: `packages/aai-server/sandbox-slots.ts` -- Slot cache is an unbounded Map with no max slots limit or LRU eviction.

**Recommendation**:
- Add a configurable maximum slot count in `sandbox-slots.ts`
- Document that the orchestrator (Fly.io) must enforce memory/PID limits
- Consider adding `--pids-limit` if cgroup support is available

### 1.5 Dev Mode Fallback -- ACCEPTABLE (by design)

**Location**: `packages/aai-server/sandbox-vm.ts:153` and `packages/aai-server/guest/fake-vm.ts`

macOS dev mode provides zero isolation (plain child process). This is explicitly warned in code and blocked in production (`NODE_ENV=production` requires gVisor, line 144-149).

### 1.6 Session State Memory Leak -- MEDIUM RISK

**Location**: `packages/aai-server/guest/deno-harness.ts:209`

`sessionState.delete(sessionId)` exists but is never called from the framework automatically. Long-running sandboxes accumulate session state without cleanup.

**Recommendation**: Implement automatic session state cleanup on session close/disconnect.

---

## 2. Authentication & Credential Management

### 2.1 API Key Authentication -- STRONG

**Location**: `packages/aai-server/secrets.ts:19-64`

- SHA-256 hashing (never stored in plaintext)
- LRU-bounded hash cache (100 entries max)
- `crypto.timingSafeEqual()` for constant-time comparison
- Generic 403 "Forbidden" messages prevent slug enumeration
- Multi-user ownership preserved during redeploys (`deploy.ts:58-64`)

### 2.2 Credential Encryption -- STRONG

**Location**: `packages/aai-server/secrets.ts:75-124`

- AES-256-GCM with HKDF key derivation (SHA-256)
- **Unique IVs**: `crypto.getRandomValues()` per encryption (line 97)
- Additional Authenticated Data (AAD) includes agent slug -- prevents cross-agent tampering
- Round-trip and cross-key/cross-slug tests confirm correctness

**Low risk**: Static HKDF salt `"aai-credentials"` (line 83). Acceptable when master secret (`KV_SCOPE_SECRET`) is properly protected. Per-slug AAD provides differentiation.

**Recommendation**: Document `KV_SCOPE_SECRET` as a critical secret requiring secure rotation procedures.

### 2.3 Cross-Agent Access Control -- STRONG

**Location**: `packages/aai-server/orchestrator-security.test.ts:17-186`

Comprehensive test coverage verifies:
- Agent A's key cannot deploy to Agent B's slug (403)
- Agent A's key cannot delete Agent B (403)
- Agent A's key cannot manage Agent B's secrets (403)
- Error messages are generic (no information leakage)

### 2.4 KV Store Isolation -- STRONG

**Location**: `packages/aai-server/kv-handler.ts:9-11`, `packages/aai/host/unstorage-kv.ts:38-69`

- Host-enforced prefix: `agents/{slug}/kv` -- guest cannot control prefix
- Slug validated with strict regex `/^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/`
- Cross-agent isolation verified in tests (`orchestrator-security.test.ts:17-108`)

### 2.5 Session Security -- STRONG

- Session IDs: `crypto.randomUUID()` (128-bit random, infeasible to guess)
- Per-agent `sessions` Map prevents cross-agent session hijacking
- Resume via `?sessionId=<uuid>` is safe given UUID entropy

### 2.6 Default Credential Scope -- LOW RISK

**Location**: `packages/aai-server/constants.ts:20`

`DEFAULT_CREDENTIAL_SCOPE = "default-credential-key"` used only in local dev when `KV_SCOPE_SECRET` is unset. Production requires explicit `KV_SCOPE_SECRET`.

---

## 3. SSRF & Network Security

### 3.1 SSRF Protection -- STRONG

**Location**: `packages/aai-server/ssrf.ts:29-59`

- **Resolve-then-pin strategy** prevents DNS rebinding/TOCTOU attacks (lines 67-73)
- **Private IP detection** via `bogon` library covers RFC 1918, loopback, link-local, carrier-grade NAT, IPv6 ranges
- **IPv4-mapped IPv6** (`::ffff:127.0.0.1`) handled correctly
- **Cloud metadata blocking**: `metadata.google.internal`, `instance-data.ec2.internal`, `.internal`/`.local` TLDs
- **Protocol validation**: Only `http:` and `https:` allowed (lines 33-35)
- **Redirect validation**: 5-hop limit with re-validation at each hop (line 61)
- **URL parsing**: Standard `URL` API -- no parser differential attacks

### 3.2 WebSocket Origin Validation -- MEDIUM RISK

**Location**: `packages/aai-server/orchestrator.ts:167`

WebSocket upgrade handler does not explicitly validate the `Origin` header. The `ws` library accepts connections without origin checks.

**Mitigating factor**: CORS middleware provides some defense at the HTTP layer (`orchestrator.ts:44-57`).

**Recommendation**: Add explicit Origin header validation before `handleUpgrade()` to prevent cross-site WebSocket hijacking.

### 3.3 Path Traversal Protection -- STRONG

**Location**: `packages/aai-server/schemas.ts:14-21`

`SafePathSchema` provides comprehensive protection:
- Null byte rejection
- Backslash rejection
- `path.posix.normalize()` canonicalization
- Relative-only paths (no leading `/`)
- No `..` traversal above root

### 3.4 Slug Validation -- STRONG

**Location**: `packages/aai-server/schemas.ts:23`

`/^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/` -- lowercase alphanumeric + underscore/hyphen, 2-64 chars.

### 3.5 Connection Rate Limiting -- ADEQUATE

- `MAX_CONNECTIONS` enforced per environment variable (default 100)
- `maxPayload: MAX_WS_PAYLOAD_BYTES` prevents memory exhaustion
- No per-IP rate limiting (relies on upstream proxy/Fly.io)

### 3.6 Internal Endpoint Protection -- STRONG

**Location**: `packages/aai-server/middleware.ts:72-81`

`requireInternal()` prefers socket address over proxy headers (not spoofable), with proxy header fallback.

---

## 4. Input Validation & Injection

### 4.1 Protocol Message Validation -- STRONG

**Location**: `packages/aai/sdk/protocol.ts:20-42`

- Zod-based discriminated union schemas for all client/server messages
- Two-phase parsing with lenient fallback (`lenientParse()`)
- History messages: max 200 items, each max 100,000 chars
- Tool results: max 4,000 chars

### 4.2 Manifest Parsing -- STRONG

**Location**: `packages/aai/sdk/manifest.ts:50-64`

Data-only manifests with no executable code. Zod validation with safe defaults.

### 4.3 Tool Execution -- STRONG

**Location**: `packages/aai/host/tool-executor.ts:46-80`

- Arguments validated via `schema.safeParse(args)` before execution
- 30-second timeout on execution
- Invalid arguments rejected with detailed error

### 4.4 Deploy/Upload Validation -- STRONG

**Location**: `packages/aai-server/deploy.ts`, `packages/aai-server/schemas.ts:25-34`

- Worker bundle: max 10 MB
- Client files: max 100 files, each max 10 MB
- File paths validated with `SafePathSchema`
- Credential hashes merged to prevent owner loss

### 4.5 CLI Command Safety -- STRONG

- `execFileSync` with safe array form (never `shell: true`)
- No user input in command arguments
- Test file paths hardcoded after existence check

### 4.6 HTML Sanitization -- STRONG

**Location**: `packages/aai/host/builtin-tools.ts:23-35`

- Script/style tags stripped with lazy quantifiers (no ReDoS risk)
- Input capped at 200KB before processing
- Agent name HTML-escaped before embedding in default HTML

### 4.7 System Prompt Injection -- INFORMATIONAL

**Location**: `packages/aai/sdk/system-prompt.ts:43-74`

User-controlled system prompt embedded without escaping. This is inherent to LLM systems and not addressable at code level.

### 4.8 Secret Key Validation -- STRONG

**Location**: `packages/aai-server/schemas.ts:49`

Secret keys validated with `/^[a-zA-Z_]\w*$/` -- prevents injection via key names.

---

## 5. Supply Chain & Dependencies

### 5.1 Dependency Versioning -- STRONG

- No wildcard versions; all use semantic versioning
- `syncpackrc.json` enforces matching versions of shared deps (zod, ws)
- Dependabot configured with weekly schedule (`.github/dependabot.yml`)

### 5.2 Lockfile Integrity -- STRONG

`--frozen-lockfile` enforced in all Dockerfiles and CI workflows:
- `Dockerfile.test:32`
- `packages/aai-server/Dockerfile:21,56`
- `packages/aai-server/guest/Dockerfile.gvisor:36`
- `.github/workflows/check.yml:26,41,145,195`

### 5.3 Postinstall Script Protection -- STRONG

- Zero postinstall/preinstall hooks in package.json files
- `--ignore-scripts` flag on all Docker/CI installs
- Binary deps explicitly listed in `onlyBuiltDependencies` config

### 5.4 Secrets in Source Control -- STRONG

- `.env` and `.env.*` in `.gitignore` (except `.env.example`)
- Biome `noSecrets: "error"` enforces secret detection at lint time
- No hardcoded API keys or credentials found in source

### 5.5 Curl|Bash in Dockerfiles -- LOW RISK

**Location**: `Dockerfile.test:20`, `packages/aai-server/Dockerfile:45`, `packages/aai-server/guest/Dockerfile.gvisor:22`

Deno installed via `curl | sh` from `deno.land`. Uses HTTPS with certificate verification.

**Recommendation**: Replace with explicit version-pinned download from GitHub releases for reproducibility and to eliminate MITM risk during build.

### 5.6 GitHub Actions Pin -- LOW RISK

**Location**: `.github/workflows/release.yml:82`

`superfly/flyctl-actions/setup-flyctl@master` uses `@master` instead of a pinned tag.

**Recommendation**: Pin to a specific version tag (e.g., `@v1`) to prevent supply chain attacks via upstream tag mutation.

### 5.7 Build Cache Security -- STRONG

- Turbo: local cache only, no remote cache configured
- GitHub Actions: lockfile hash in cache keys
- No environment variable leakage to cache

### 5.8 NPM Publishing Security -- STRONG

- `NPM_CONFIG_PROVENANCE: true` enables OIDC-backed package signing
- OIDC `id-token: write` permission for provenance attestation

---

## 6. Security Test Coverage

### Existing Test Coverage -- COMPREHENSIVE

| Test File | Coverage Area |
|-----------|---------------|
| `orchestrator-security.test.ts` | Cross-agent isolation, slug validation, CORS, security headers |
| `ssrf.test.ts` / `ssrf-extended.test.ts` | IP encoding bypasses, DNS rebinding, redirect chains |
| `auth.test.ts` | Timing-safe comparison, hash length consistency |
| `credentials.test.ts` | AES-256-GCM round-trip, cross-key/cross-slug rejection |
| `builtin-tools.test.ts` | node:vm escape prevention, constructor chain, import blocking |
| `gvisor-integration.test.ts` | Network/filesystem/process/env isolation in gVisor |
| `sandbox-integration.test.ts` | Sandbox lifecycle and slot management |
| `net.test.ts` | SSRF bypass prevention vectors |
| `unstorage-kv.test.ts` | KV prefix isolation, multi-agent separation |

### Coverage Gaps

1. **NDJSON response validation**: No tests for malformed guest responses beyond KV
2. **WebSocket Origin header**: No tests for cross-origin WebSocket hijacking
3. **Slot exhaustion**: No tests for max connection/slot limits
4. **Session state cleanup**: No tests for memory leak from abandoned sessions
5. **Type-level tests**: Subpath exports (`./kv`, `./protocol`) not covered

---

## 7. Remediation Plan

### Priority 1 -- High (Address within 1 sprint)

| # | Finding | Location | Action |
|---|---------|----------|--------|
| H-1 | NDJSON guest responses unvalidated | `ndjson-transport.ts:104`, `sandbox.ts:95` | Add Zod schemas for all guest-to-host response types, matching KV bridge pattern |

### Priority 2 -- Medium (Address within 2 sprints)

| # | Finding | Location | Action |
|---|---------|----------|--------|
| M-1 | WebSocket Origin not validated | `orchestrator.ts:167` | Add explicit Origin header check before `handleUpgrade()` |
| M-2 | node:vm escape risk | `_run-code.ts` | Document gVisor as true security boundary; pin Node.js version; monitor CVEs |
| M-3 | cgroup limits delegated | `gvisor.ts:88` | Add max slot count; document orchestrator requirements |
| M-4 | Session state memory leak | `deno-harness.ts:209` | Implement automatic session state cleanup on disconnect |

### Priority 3 -- Low (Address when convenient)

| # | Finding | Location | Action |
|---|---------|----------|--------|
| L-1 | Static HKDF salt | `secrets.ts:83` | Document `KV_SCOPE_SECRET` rotation procedures |
| L-2 | Curl\|bash Deno install | `Dockerfile.test:20` | Pin explicit Deno version via GitHub releases download |
| L-3 | Flyctl @master | `release.yml:82` | Pin to `@v1` or specific SHA |
| L-4 | No KV rate limiting | `kv-handler.ts` | Consider per-agent request rate limiting |
| L-5 | No per-IP rate limiting | `orchestrator.ts` | Document reliance on upstream proxy (Fly.io) for rate limiting |
| L-6 | Alibaba Cloud metadata | `ssrf.ts:14` | Add `100.100.100.200` to BLOCKED_HOSTS if relevant |

### Priority 4 -- Informational (No code change needed)

| # | Finding | Notes |
|---|---------|-------|
| I-1 | LLM prompt injection | Inherent to LLM systems; not addressable at code level |
| I-2 | Dev mode zero isolation | Explicitly documented and blocked in production |
| I-3 | Default credential scope in dev | Only used when `KV_SCOPE_SECRET` unset (local dev only) |
| I-4 | Error detail exposure | Verify `exposeErrors` is only true for internal/loopback services |

---

## 8. Architecture Strengths

The security architecture demonstrates several commendable patterns:

1. **Defense in depth**: gVisor > Deno permissions > application-level validation
2. **Separation of concerns**: Host-only secrets, guest-only code execution, NDJSON bridge
3. **Consistent validation**: Zod schemas at every trust boundary
4. **Timing-safe auth**: SHA-256 hashing with `timingSafeEqual` and generic error messages
5. **SSRF resolve-then-pin**: Industry best practice for DNS rebinding prevention
6. **Supply chain hardening**: Frozen lockfiles, no postinstall scripts, secret detection linting
7. **Comprehensive test coverage**: Security-specific test files for each major attack surface
