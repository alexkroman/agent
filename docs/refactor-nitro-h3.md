# Refactor: Nitro (Platform) + h3 (SDK)

## Goal

Replace Hono with **h3** in the SDK (`packages/aai`) and **Nitro** in the
platform server (`packages/aai-server`). h3 apps mount natively in Nitro,
eliminating the adapter layer. The client (`aai-ui`) is unchanged.

## Guiding Principles

- **h3 in the SDK** — `createAgentApp()` returns an h3 app (lightweight,
  embeddable, composable). Self-hosted users use `toNodeHandler()` to serve it.
- **Nitro in the platform** — `aai-server` becomes a Nitro app. Agent h3 apps
  mount directly. Nitro provides dev server, storage config, graceful lifecycle.
- **Client unchanged** — `aai-ui` stays Preact. `_bundler.ts` still produces
  `worker.js` + `client/` via Vite. No Nuxt, no SSR.
- **Incremental migration** — Each phase results in a working system. Tests
  pass after every phase.

---

## Phase 1: Sandbox Sidecar → h3 (Isolated, Low Risk)

**Files:**

- `packages/aai-server/src/sandbox-sidecar.ts`
- `packages/aai-server/src/sandbox-sidecar.test.ts`

**What changes:**

- Replace `new Hono()` with `createApp()` + `createRouter()` from h3
- Replace `@hono/node-server.serve()` with `createServer(toNodeHandler(app))`
  from `node:http` + h3
- Replace `@hono/zod-validator` with manual `readValidatedBody(event, schema.parse)`
  (h3 has built-in Zod support via `readValidatedBody`)
- Replace `c.json()` with returning objects directly (h3 auto-serializes)
- Replace `c.req.valid("json")` with `readValidatedBody(event, schema.parse)`
- Replace `app.onError()` with h3 error handler

**API mapping:**

```ts
// Before (Hono)
app.post("/kv/get", zValidator("json", schema), (c) => {
  const { key } = c.req.valid("json");
  return c.json({ value });
});

// After (h3)
router.post("/kv/get", defineEventHandler(async (event) => {
  const { key } = await readValidatedBody(event, schema.parse);
  return { value };  // auto-serialized to JSON
}));
```

**Tests:** Update to use `toNodeHandler()` + native `fetch()` against a
local server (same pattern as current tests, which already use real HTTP).

---

## Phase 2: SDK Server → h3 (`packages/aai/server.ts`)

**Files:**

- `packages/aai/server.ts`
- `packages/aai/package.json` (peer deps: hono → h3)

**What changes:**

### `createAgentApp()` — Returns h3 app instead of Hono app

```ts
// Before
export type AgentApp = {
  app: Hono;
  injectWebSocket: (server: ReturnType<typeof serve>) => void;
  shutdown(): Promise<void>;
};

// After
export type AgentApp = {
  app: App;  // h3 App
  handler: NodeHandler;  // toNodeHandler(app) — for Node HTTP servers
  shutdown(): Promise<void>;
};
```

Key migrations (Hono → h3):

- `new Hono()` → `createApp()` + `createRouter()`
- `app.get("/health", (c) => c.json(...))` →
  `router.get("/health", defineEventHandler(...))`
- `app.use("*", secureHeaders())` →
  Custom h3 middleware or `setHeaders(event, {...})`
- `app.use("*", honoLogger(...))` →
  h3 `onRequest` / `onAfterResponse` hooks
- `serveStatic({ root })` →
  `serveStatic({ dir })` from h3 or `sirv` package
- `c.html(...)` →
  `setResponseHeader(event, "content-type", "text/html")`
- `c.header("CSP", ...)` →
  `setResponseHeader(event, "Content-Security-Policy", ...)`
- `c.req.query("key")` → `getQuery(event).key`
- `upgradeWebSocket(...)` → `defineWebSocketHandler(...)` via crossws (h3 built-in)

### WebSocket migration

```ts
// Before (Hono + @hono/node-ws)
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
app.get("/websocket", upgradeWebSocket((c) => ({
  onOpen(_evt, ws) { runtime.startSession(ws.raw, opts); }
})));

// After (h3 + crossws)
router.get("/websocket", defineWebSocketHandler({
  open(peer) {
    const url = new URL(peer.request.url);
    const resumeFrom = url.searchParams.get("sessionId") ?? undefined;
    runtime.startSession(peer, { skipGreeting: !!resumeFrom, resumeFrom });
  }
}));
```

**Important:** Verify that `peer` from crossws exposes a compatible WebSocket
interface for `runtime.startSession()`. Check `ws-handler.ts` for the minimal
interface required (`send`, `close`, event callbacks). You may need a thin
adapter: `peer.websocket` or `peer.raw`.

### `createServer()` — Uses Node HTTP directly

```ts
// Before
const nodeServer = serve({ fetch: app.fetch, port });
injectWebSocket(nodeServer);

// After
import { createServer as createHttpServer } from "node:http";
import { toNodeHandler } from "h3";

const handler = toNodeHandler(app);
const nodeServer = createHttpServer(handler);
// crossws handles WebSocket upgrades automatically when using h3 WebSocket
nodeServer.listen(port);
```

### Public API change (BREAKING)

`createAgentApp()` no longer returns a Hono app. Users who compose it into
their own Hono app (as shown in the docstring example) need to update:

```ts
// Before
const { app: agentApp } = createAgentApp({ runtime });
const myApp = new Hono();
myApp.route("/agent", agentApp);

// After
const { app: agentApp, handler } = createAgentApp({ runtime });
// Option A: use the h3 app directly
// Option B: mount handler into your own Node HTTP server
```

Document this as a breaking change. Consider a migration guide.

---

## Phase 3: Platform Server → Nitro (`packages/aai-server`)

This is the largest phase. Convert the orchestrator from a Hono app to a
Nitro application.

### 3a: Project Structure

```text
packages/aai-server/
  nitro.config.ts           ← NEW: Nitro configuration
  src/
    routes/
      health.get.ts         ← NEW: file-based route (optional, see below)
    plugins/
      storage.ts            ← NEW: Nitro plugin for unstorage config
      shutdown.ts           ← NEW: graceful shutdown hook
    orchestrator.ts         ← REWRITE: h3 handlers + router
    middleware.ts           ← UPDATE: h3 middleware pattern
    factory.ts              ← DELETE: Hono factory no longer needed
    context.ts              ← UPDATE: h3 context pattern
    ...
```

**Decision: file-based routes vs programmatic router.** The orchestrator has
dynamic `/:slug` routing with middleware guards. File-based routing doesn't
map well to this pattern. **Keep the programmatic router** — define h3 routes
in `orchestrator.ts` just as today, but use h3 APIs. Use Nitro for server
lifecycle, storage, and build only.

### 3b: Nitro Configuration

```ts
// nitro.config.ts
import { defineNitroConfig } from "nitropack/config";

export default defineNitroConfig({
  // Use programmatic entry, not file-based routes
  preset: "node-server",
  entry: "./src/index.ts",

  storage: {
    // Nitro's built-in unstorage — replaces manual overlay setup in index.ts
    data: {
      driver: process.env.BUCKET_NAME ? "s3" : "memory",
      // S3 config from env...
    },
  },

  experimental: {
    websocket: true,  // Enable crossws WebSocket support
  },
});
```

### 3c: Context Migration

Replace Hono's `Env` type with h3 event context:

```ts
// Before (Hono)
type Env = {
  Bindings: { slots, store, storage };
  Variables: { slug, keyHash };
};
// Access: c.env.store, c.var.slug

// After (h3)
// Set on event context:
event.context.slots = slots;
event.context.store = store;
event.context.storage = storage;
event.context.slug = slug;
event.context.keyHash = keyHash;

// Typed via module augmentation:
declare module "h3" {
  interface H3EventContext {
    slots: Map<string, AgentSlot>;
    store: BundleStore;
    storage: Storage;
    slug?: string;
    keyHash?: string;
  }
}
```

### 3d: Middleware Migration

```ts
// Before (Hono factory middleware)
const slugMw = factory.createMiddleware(async (c, next) => {
  c.set("slug", validateSlug(c.req.param("slug")!));
  await next();
});

// After (h3)
function slugMiddleware(event: H3Event) {
  const slug = getRouterParam(event, "slug");
  event.context.slug = validateSlug(slug!);
}
// Used inline: router.post("/deploy", defineEventHandler(async (event) => {
//   slugMiddleware(event);
//   ownerMiddleware(event);
//   return handleDeploy(event);
// }));
//
// Or as h3 middleware via router.use()
```

### 3e: Orchestrator Rewrite

```ts
// Before
export function createOrchestrator(opts): Orchestrator {
  const app = new Hono<Env>();
  // ... 186 lines of Hono routes
  return { app, injectWebSocket };
}

// After
export function createOrchestrator(opts): { app: App; handler: NodeHandler } {
  const app = createApp();
  const router = createRouter();

  // Global middleware
  app.use(defineEventHandler((event) => {
    // CORS
    handleCors(event, { origin: opts.allowedOrigins ?? ["*"] });
    // Security headers
    setResponseHeaders(event, {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
  }));

  router.get("/health", defineEventHandler(() => ({ status: "ok" })));

  router.get("/metrics", defineEventHandler(async (event) => {
    requireInternal(event);
    setResponseHeader(event, "Content-Type", "text/plain; version=0.0.4");
    return await serialize();
  }));

  // Slug-scoped routes
  router.post("/:slug/deploy", defineEventHandler(async (event) => {
    slugMiddleware(event);
    await ownerMiddleware(event);
    return handleDeploy(event);
  }));

  // ... remaining routes follow same pattern

  // WebSocket
  router.get("/:slug/websocket", defineWebSocketHandler({
    async open(peer) {
      const slug = peer.request.context.slug;
      const sandbox = await resolveSandbox(slug, opts);
      if (!sandbox) { peer.close(1008, "Agent not found"); return; }
      sandbox.startSession(peer, {});
    }
  }));

  app.use(router);
  return { app, handler: toNodeHandler(app) };
}
```

### 3f: Error Handling

```ts
// Before (Hono)
throw new HTTPException(401, { message: "Unauthorized" });
app.onError(createErrorHandler());

// After (h3)
throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
// h3 handles errors automatically, or add:
app.use(defineEventHandler({ onError(error, event) { /* ... */ } }));
```

### 3g: Handler Migration

Each handler file (`deploy.ts`, `secret-handler.ts`, `kv-handler.ts`,
`transport-websocket.ts`, `delete.ts`) follows the same pattern:

```ts
// Before
export const handleDeploy = async (c: AppContext) => {
  const slug = c.var.slug;
  const body = DeployBodySchema.parse(await c.req.json());
  // ... logic
  return c.json({ url }, 200);
};

// After
export const handleDeploy = defineEventHandler(async (event) => {
  const slug = event.context.slug;
  const body = await readValidatedBody(event, DeployBodySchema.parse);
  // ... logic
  return { url };
});
```

### 3h: Server Bootstrap

```ts
// Before (index.ts)
const { app, injectWebSocket } = createOrchestrator(opts);
const nodeServer = serve({ fetch: app.fetch, port });
injectWebSocket(nodeServer);

// After (index.ts) — Nitro handles this
// nitro.config.ts defines the server
// Or manual bootstrap:
const { handler } = createOrchestrator(opts);
const server = createServer(handler);
server.listen(port);
// crossws WebSocket support is automatic with h3's experimental websocket
```

### 3i: Graceful Shutdown

```ts
// Before: manual signal handlers in index.ts
// After: Nitro hooks
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook("close", async () => {
    for (const [, slot] of slots) clearTimeout(slot.idleTimer);
    await Promise.allSettled(
      [...slots.values()].map(s => s.sandbox?.terminate())
    );
  });
});
```

---

## Phase 4: Test Migration

**Pattern change:** Hono's `app.request()` → h3 test utilities.

```ts
// Before (Hono test pattern)
const res = await app.request("/health");
expect(res.status).toBe(200);

// After (h3 — use toNodeHandler + native fetch, or h3's test utils)
import { toNodeHandler } from "h3";

const handler = toNodeHandler(app);
// Option A: start a real server (current sidecar pattern — already works)
// Option B: use h3's built-in fetch testing
const res = await app.handler(new Request("http://localhost/health"));
```

**Files to update (13 test files):**

- `orchestrator.test.ts` — heaviest, tests all routes
- `kv-handler.test.ts` — uses `new Hono<Env>()` in setup
- `sandbox-sidecar.test.ts` — uses real HTTP (minimal changes)
- `deploy.test.ts`, `secret-handler.test.ts`, `delete.test.ts`
- `transport-websocket.test.ts`, `middleware.test.ts`, `auth.test.ts`
- `_schemas.test.ts`, `bundle-store.test.ts`, `sandbox.test.ts`
- `sandbox-integration.test.ts`
- `_test-utils.ts` — shared test orchestrator factory

**Update `_test-utils.ts` first** — `createTestOrchestrator()` creates the
app used by most tests. Migrate this and most tests follow.

---

## Phase 5: CLI Updates (`packages/aai-cli`)

**Files:**

- `packages/aai-cli/_server-common.ts` — calls `createServer()` from SDK
- `packages/aai-cli/dev.ts` — dev server setup
- `packages/aai-cli/package.json` — drop hono deps

`_server-common.ts` only uses `createRuntime()` and `createServer()` from
the SDK. Since the SDK's public API stays the same (just h3 under the hood),
**minimal changes needed** — just verify the import still works.

`dev.ts` dual-port proxy: The Vite dev server proxies `/websocket` and
`/health` to the backend. The backend is started via `bootServer()` which
calls `createServer().listen()`. Since `createServer()` still returns
`{ listen, close, port }`, **no changes to dev.ts** unless you want to
unify the dev server with Nitro (optional future improvement).

---

## Phase 6: Dependency Cleanup

### Add

- `h3` — `aai` (dep), `aai-server` (dep)
- `crossws` — `aai` (dep), `aai-server` (dep) — h3 WebSocket
- `nitropack` — `aai-server` (dep) — if using Nitro build/dev
- `h3-cors` or inline — `aai-server` — CORS middleware

### Remove

- `hono` — `aai` (peer dep), `aai-server` (dep), `aai-cli` (dep)
- `@hono/node-server` — `aai` (peer dep), `aai-server` (dep), `aai-cli` (dep)
- `@hono/node-ws` — `aai` (peer dep), `aai-server` (dep)
- `@hono/zod-validator` — `aai-server` (dep)

### Update

- `packages/aai/package.json` — peer deps: remove hono, add h3
- `packages/aai-server/package.json` — deps: remove hono/\*, add h3/nitro
- `packages/aai-cli/package.json` — deps: remove hono/\*

---

## Phase 7: Build Config Updates

**`packages/aai-server/tsdown.config.ts`:**

- Main bundle: replace Hono externals with h3 externals
- Harness runtime: **no changes** (already avoids Hono — uses `node:http`)
- Note from existing code: "@hono/node-server redefines globalThis.Request
  which conflicts with secure-exec's frozen built-ins." Verify h3 does NOT
  have this problem. If it does, use the same isolation strategy.

**`packages/aai/tsdown.config.ts`:**

- Entry points unchanged (server.ts still exports same public API)
- External deps change from hono to h3

---

## WebSocket Compatibility Checklist

The migration's riskiest part is WebSocket handling. Verify:

1. **`ws-handler.ts` interface** — What minimal WebSocket interface does
   `wireSessionSocket()` / `runtime.startSession()` expect? (likely: `send`,
   `close`, `onmessage`, `onclose`). Ensure crossws `Peer` satisfies this
   or write a thin adapter.

2. **Binary frames** — Audio is sent as `Uint8Array` over WebSocket. Verify
   crossws supports binary message types without base64 encoding.

3. **Session resume** — Query params (`?sessionId=X&resume`) must be
   accessible from the WebSocket upgrade request. Verify crossws exposes the
   original HTTP request URL.

4. **Backpressure** — Verify crossws handles the same volume of binary
   frames as `@hono/node-ws` without buffering issues.

---

## Breaking Changes

1. **`createAgentApp()` return type** — `app` is now an h3 `App`, not a
   Hono instance. Users who import and compose this need to update.
2. **Peer dependencies** — `hono` → `h3` for self-hosted users.
3. **`AgentApp.injectWebSocket`** — Removed. crossws handles WebSocket
   upgrades automatically.
4. **Middleware composition** — Users adding custom Hono middleware to the
   agent app need to rewrite for h3.

---

## Migration Order

```text
Phase 1  ──►  Phase 2  ──►  Phase 3  ──►  Phase 4  ──►  Phase 5  ──►  Phase 6  ──►  Phase 7
sidecar       SDK server     platform      tests         CLI           deps          build
(isolated)    (public API)   (biggest)     (13 files)    (minimal)     (cleanup)     (verify)
```

Each phase should be a separate PR. Run `pnpm check:local` after each phase.
Phase 2 is the most important to get right (public API change). Phase 3 is
the most work (orchestrator + all handlers).

---

## What NOT to Change

- `packages/aai-ui/` — no changes (Preact client, WebSocket consumer)
- `packages/aai/ws-handler.ts` — no changes (transport-agnostic session logic)
- `packages/aai/middleware.ts` — no changes (zero-dep, isolate-safe)
- `packages/aai-server/src/_harness-runtime.ts` — no changes (V8 isolate)
- `packages/aai-server/src/_harness-protocol.ts` — no changes
- `packages/aai-cli/_bundler.ts` — no changes (Vite builds, not HTTP)
- `packages/aai-cli/dev.ts` — minimal changes (bootServer API unchanged)
- Template files — no changes (they use `defineAgent`, not server internals)

---

## Validation Checklist (Run After Each Phase)

```sh
pnpm check:local          # build + typecheck + lint + test
pnpm test:integration     # real HTTP/WS tests
pnpm test:e2e             # full process spawn + browser
```

Specifically verify:

- [ ] WebSocket connects and streams audio bidirectionally
- [ ] Session resume works (`?sessionId=X`)
- [ ] Tool calls execute and return results
- [ ] KV read/write works (both SDK and platform)
- [ ] CORS headers present on responses
- [ ] Security headers present (CSP, X-Frame-Options, etc.)
- [ ] Static client files served correctly
- [ ] Graceful shutdown terminates all sessions
- [ ] Sidecar SSRF protection still blocks private IPs
- [ ] Sandbox isolation unchanged (integration tests pass)
