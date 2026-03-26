# Security QA Report

## Summary

Audit of the AAI codebase across all four packages (`aai`, `aai-ui`, `aai-cli`, `aai-server`) identified 14 security issues ranging from critical to low severity. The most significant findings include: no SSRF protection on self-hosted built-in network tools, unauthenticated WebSocket endpoints on the platform server, use of `new Function()` in a template, missing DNS rebinding protections in the SSRF guard, and missing rate limiting on several endpoints.

## Issues Found

### Issue 1: Self-hosted built-in tools (`web_search`, `visit_webpage`, `fetch_json`) lack SSRF protection
- **File**: `/home/user/agent/packages/aai/builtin-tools.ts:55-166`
- **Severity**: Critical
- **Description**: The `createWebSearch`, `createVisitWebpage`, and `createFetchJson` tools accept arbitrary user-controlled URLs and pass them directly to `fetch()` without any SSRF validation. In self-hosted mode (via `createServer()`), there is no `assertPublicUrl()` check. An LLM tool call with a URL like `http://169.254.169.254/latest/meta-data/` or `http://127.0.0.1:6379/` would fetch internal services. The platform sandbox restricts network at the isolate level, but the self-hosted server runs these tools in-process with full network access.
- **Recommendation**: Apply `assertPublicUrl()` (or an equivalent check) to all user-supplied URLs in `visit_webpage`, `fetch_json`, and `web_search` before making fetch requests, even in self-hosted mode. Extract the SSRF check from `aai-server/_net.ts` into a shared utility in the `aai` package.

### Issue 2: Unauthenticated WebSocket connections on the platform server
- **File**: `/home/user/agent/packages/aai-server/src/index.ts:76-106`
- **Severity**: High
- **Description**: The WebSocket upgrade handler at `/:slug/websocket` does not require any authentication. Any client that knows or guesses a slug can connect, start a voice session, and consume the agent's AssemblyAI API key credits. The slug format (`humanId`) is predictable. HTTP endpoints like `/deploy` and `/secret` require owner auth, but the WebSocket endpoint has none.
- **Recommendation**: Require a scope token, session token, or API key on WebSocket upgrade requests. At minimum, verify a short-lived token in the `?token=` query parameter or `Sec-WebSocket-Protocol` header before completing the upgrade.

### Issue 3: `new Function()` code execution in template calculator tool
- **File**: `/home/user/agent/packages/aai-cli/templates/middleware/agent.ts:173`
- **Severity**: High
- **Description**: The middleware template's `calculate` tool uses `new Function(\`return (${sanitized})\`)()` to evaluate math expressions. The sanitization regex `expression.replace(/[^0-9+\-*/().% ]/g, "")` is insufficient -- the remaining characters (parentheses, periods, percent, spaces) can be combined to construct unexpected behavior. While this is a template (not production SDK code), users who scaffold from it will ship this vulnerability. The biome-ignore comment explicitly suppresses the linter's security warning.
- **Recommendation**: Replace `new Function()` with a proper math expression parser (e.g., `mathjs` or a simple recursive-descent parser). Alternatively, use the `run_code` built-in tool which executes in a sandboxed V8 isolate.

### Issue 4: SSRF guard does not perform DNS resolution -- vulnerable to DNS rebinding
- **File**: `/home/user/agent/packages/aai-server/src/_net.ts:55-75`
- **Severity**: High
- **Description**: `assertPublicUrl()` validates the hostname string against a blocklist, but it does not resolve the hostname to an IP address before checking. An attacker can use a DNS rebinding attack: register a domain that first resolves to a public IP (passing the check) and then resolves to `127.0.0.1` or `169.254.169.254` when the actual HTTP request is made. The hostname-based checks (`localhost`, `.local`, `.internal`) are easily bypassed with custom domains.
- **Recommendation**: Resolve the hostname to IP addresses (via `dns.lookup()`) before making the request, and validate the resolved IPs against the private IP blocklist. Consider using a connect-time check via a custom `Agent` that validates the socket address.

### Issue 5: No CORS or origin validation on self-hosted WebSocket server
- **File**: `/home/user/agent/packages/aai/server.ts:131-139`
- **Severity**: Medium
- **Description**: The self-hosted server's WebSocket upgrade handler does not validate the `Origin` header. Any web page can connect to the WebSocket endpoint via JavaScript, enabling cross-site WebSocket hijacking. An attacker's page could connect to a victim's locally-running agent server and interact with it, potentially accessing tools and data.
- **Recommendation**: Validate the `Origin` header on WebSocket upgrade requests. Reject connections from unexpected origins. At minimum, check that the origin matches the server's own host or is explicitly allowed.

### Issue 6: Harness HTTP server inside isolate has no authentication
- **File**: `/home/user/agent/packages/aai-server/src/_harness-runtime.ts:359-381`
- **Severity**: Medium
- **Description**: The harness HTTP server running inside the V8 isolate listens on `127.0.0.1` on an ephemeral port and accepts tool/hook calls without any authentication or shared secret. While the network policy restricts the isolate's outbound access, any process on the same host (including other isolates if the network policy has gaps) could call `/tool` or `/hook` endpoints on the harness port to execute arbitrary tool calls.
- **Recommendation**: Add a shared secret (generated per-sandbox) that must be included in requests to the harness server. The host already controls the isolate's environment, so a random token in an env var would work.

### Issue 7: No rate limiting on deploy, secret, and WebSocket endpoints
- **File**: `/home/user/agent/packages/aai-server/src/orchestrator.ts:114-129`
- **Severity**: Medium
- **Description**: The platform server has no rate limiting on any endpoint. The `/deploy` endpoint accepts 10MB bundles, `/secret` endpoints accept unlimited requests, and the WebSocket endpoint allows unlimited connections. An attacker could exhaust resources via rapid deploys (filling storage), secret operations, or opening many simultaneous WebSocket sessions (each spawning an isolate with 128MB memory).
- **Recommendation**: Add rate limiting middleware (e.g., per-IP or per-API-key) to deploy, secret, and WebSocket endpoints. Add a maximum concurrent sessions limit per agent/slug.

### Issue 8: `requireInternal` relies on spoofable headers for IP verification
- **File**: `/home/user/agent/packages/aai-server/src/middleware.ts:49-55`
- **Severity**: Medium
- **Description**: `requireInternal()` checks `CF-Connecting-IP` or `Fly-Client-IP` headers to determine if a request is from a private IP. These headers are set by reverse proxies (Cloudflare, Fly.io) but can be spoofed if the server is directly accessible without the proxy. If an attacker bypasses the proxy layer, they can set these headers to a private IP and access internal-only endpoints like `/metrics`.
- **Recommendation**: Ensure the server is only accessible behind the expected proxy (firewall rules), or validate the actual TCP connection source IP in addition to proxy headers. Use `req.socket.remoteAddress` as a fallback.

### Issue 9: Error messages in harness runtime may leak internal details
- **File**: `/home/user/agent/packages/aai-server/src/_harness-runtime.ts:376-379`
- **Severity**: Low
- **Description**: When tool execution or hook invocation fails, the harness returns the raw error message to the host via HTTP: `json(res, { error: message }, status)`. The host then includes this in logs and may propagate it to the client. Error messages from tool execution can contain stack traces, file paths, or internal state that should not be exposed to end users.
- **Recommendation**: Sanitize error messages before returning them to clients. Return generic error messages to the WebSocket client and log detailed errors server-side only.

### Issue 10: `visit_webpage` tool follows redirects without SSRF re-validation
- **File**: `/home/user/agent/packages/aai/builtin-tools.ts:108-115`
- **Severity**: High
- **Description**: The `visit_webpage` tool uses `redirect: "follow"` in its fetch options. Even if SSRF protection were added to validate the initial URL, the redirect target is not validated. An attacker could host a page at a public URL that 302-redirects to `http://169.254.169.254/latest/meta-data/` or an internal service, bypassing any pre-fetch URL validation.
- **Recommendation**: Either disable automatic redirects (`redirect: "manual"`) and validate each redirect URL before following it, or use a custom fetch agent that validates the resolved IP at connect time.

### Issue 11: API key stored in plaintext in config file
- **File**: `/home/user/agent/packages/aai-cli/_discover.ts:47-52`
- **Severity**: Low
- **Description**: The AssemblyAI API key is stored as plaintext JSON in `~/.config/aai/config.json`. While the file permissions are set to `0o600` on non-Windows platforms, on Windows no permission restriction is applied. Additionally, file permissions alone do not protect against malware, backup tools, or other processes running as the same user.
- **Recommendation**: On Windows, use the Windows Credential Manager or DPAPI for secret storage. Consider supporting OS keychain integration (macOS Keychain, Linux Secret Service) for all platforms.

### Issue 12: `timingSafeCompare` leaks length information
- **File**: `/home/user/agent/packages/aai-server/src/auth.ts:13-16`
- **Severity**: Low
- **Description**: `timingSafeCompare` returns `false` immediately when the two strings have different lengths (`if (a.length !== b.length) return false`). This leaks the length of the stored credential hash through timing. In this specific case the hashes are always SHA-256 hex strings (64 chars), so the practical impact is minimal, but the pattern is unsafe if reused elsewhere.
- **Recommendation**: Pad or normalize inputs to a fixed length before comparison, or always perform the full `timingSafeEqual` call regardless of length mismatch (e.g., by comparing against a dummy buffer of the same length when lengths differ).

### Issue 13: Sidecar server has no authentication -- relies solely on loopback binding
- **File**: `/home/user/agent/packages/aai-server/src/sandbox-sidecar.ts:98-189`
- **Severity**: Low
- **Description**: The per-sandbox sidecar server binds to `127.0.0.1` on an ephemeral port and has no authentication mechanism. Any process on the host machine can access any sidecar's KV and vector store data. In a multi-tenant deployment, if multiple agents run on the same host, a compromised agent process (outside the isolate) could discover and access other agents' sidecar ports.
- **Recommendation**: Add a per-sidecar authentication token that is only shared with the corresponding isolate. Alternatively, use Unix domain sockets with file-based access control.

### Issue 14: Agent page served without Content Security Policy
- **File**: `/home/user/agent/packages/aai-server/src/transport-websocket.ts:21-26`
- **Severity**: Medium
- **Description**: `handleAgentPage` serves user-uploaded HTML (`index.html` from the deploy bundle) via `c.html(page)`. While `secureHeaders` middleware sets some headers (X-Frame-Options, X-Content-Type-Options), there is no Content Security Policy (CSP) header. A malicious agent deployer could include inline scripts, external script sources, or other XSS payloads in their `index.html` that would execute in visitors' browsers under the platform's domain.
- **Recommendation**: Serve agent pages on a separate domain (or subdomain per agent) to isolate them from the platform's auth cookies/tokens. Add a restrictive default CSP header. Consider sandboxing agent HTML in an iframe with the `sandbox` attribute.
