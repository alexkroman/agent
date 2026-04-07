# OOM Chaos Testing & Server Hardening

**Date:** 2026-04-07
**Goal:** Prevent OOM container kills that trigger oncall pages.
**Scope:** Test + harden against resource exhaustion (WebSocket floods, unbounded sandbox spawns, memory leaks).
**Approach:** External chaos test suite using testcontainers against the real Docker container.

## Problem

The aai-server has no limits on:
- Concurrent WebSocket connections
- Number of sandbox/isolate slots
- Total container memory consumption

A connection storm or sandbox spawn burst can exhaust memory, the container gets OOM-killed, Kubernetes restarts it, and oncall gets paged. The health endpoint (`GET /health`) always returns `200 OK` regardless of resource pressure, providing no early warning.

## Test Architecture

Chaos tests live in `packages/aai-server/chaos/` as a separate Vitest tier (matching the existing pattern of `vitest.integration.config.ts` and `vitest.slow.config.ts`).

### Stack

- **testcontainers** — manages Docker compose lifecycle (server + MinIO), sets memory limits, exposes Docker stats API
- **ws** (existing dep) — WebSocket client for connection floods
- **fetch** — HTTP client for deploy API and health checks

### Lifecycle

```
beforeAll:
  1. Build Docker image from packages/aai-server/Dockerfile
  2. Start compose environment (server + MinIO) with memory cap on server
  3. Wait for health endpoint to respond
  4. Deploy a minimal no-op test agent via POST /deploy

each test:
  1. Run stress scenario
  2. Sample docker stats every 1s (memory RSS)
  3. Assert server health + memory bounds

afterAll:
  1. Tear down containers
```

### Configuration

Tests configure the server via environment variables in the compose override:
- `MAX_CONNECTIONS` — WebSocket connection cap
- `MAX_SLOTS` — sandbox slot cap
- `SLOT_IDLE_MS` — idle eviction timeout (shortened for test speed)

Container memory limit set via testcontainers `withMemoryLimit()` or compose `mem_limit`.

## Test Scenarios

### Test 1: WebSocket Connection Flood

**Purpose:** Verify the server rejects connections before OOM.

**Steps:**
1. Open WebSocket connections in rapid batches (100, 200, 500...)
2. Monitor container memory via Docker stats after each batch
3. Continue until connections are rejected or memory exceeds 90% of container limit

**Assertions:**
- Server starts rejecting new connections (socket destroyed) before memory exceeds 90% of limit
- `GET /health` remains responsive throughout
- Existing connections continue functioning (send/receive a ping)
- Memory stabilizes after rejections begin (no continued growth)

### Test 2: Concurrent Sandbox Spawn Storm

**Purpose:** Verify the server caps isolate spawns with back-pressure.

**Steps:**
1. Deploy N agents with different slugs in parallel
2. Open a WebSocket to each (triggers sandbox spawn via `resolveSandbox`)
3. Increase N until limit is reached

**Assertions:**
- Server returns an error (503 equivalent: socket destroy or HTTP 503) when slot limit reached
- Existing sandboxes continue operating
- No process crash
- Memory stays within bounds

### Test 3: Sustained Load + Idle Eviction (Leak Detection)

**Purpose:** Verify memory returns to baseline after load, no ratcheting leaks.

**Steps:**
1. Record baseline memory
2. Open connections to spawn sandboxes, sustain load for 10s
3. Close all connections, wait for idle eviction (configured short: 10s)
4. Record post-eviction memory
5. Repeat cycle 3 times

**Assertions:**
- Post-eviction memory returns to within 20% of baseline each cycle
- No monotonic increase across cycles (leak detection)
- Server health endpoint responsive throughout

### Memory Monitoring (all tests)

- Sample `docker stats` every 1s via Docker API
- Record peak RSS per test
- Fail if RSS exceeds 90% of container memory limit
- Output memory timeline on failure for debugging

## Server Hardening

### 1. Global WebSocket Connection Limit

**Files:** `constants.ts`, `orchestrator.ts`

Add a `MAX_CONNECTIONS` constant (default: 100, override via env var). Track active connection count in the WebSocket upgrade handler:

- Increment on successful upgrade
- Decrement on `close` event
- Reject (destroy socket) when count >= MAX_CONNECTIONS before calling `wss.handleUpgrade`

### 2. Sandbox Slot Cap

**Files:** `constants.ts`, `sandbox-slots.ts`

Add a `MAX_SLOTS` constant (default: 10, override via env var). In `ensureAgent()`:

- Before acquiring the spawn lock, check if active slot count (slots with a live sandbox) >= MAX_SLOTS
- If at capacity, throw a typed `SlotCapacityError`
- `orchestrator.ts` catches this in the WebSocket upgrade handler and destroys the socket

### 3. Configurable Idle Eviction Timeout

**Files:** `sandbox-slots.ts`

Replace the hardcoded `DEFAULT_SLOT_IDLE_MS` (300000ms / 5min) with:
- Read from `SLOT_IDLE_MS` env var if present
- Fall back to 300000ms default
- Allows chaos tests to use 10s for fast cycle testing

### 4. Docker Compose Memory Limit

**Files:** `docker-compose.yml`

Add to the server service:
```yaml
mem_limit: 512m
memswap_limit: 512m
```

Starting point of 512MB. Chaos tests will establish whether this is appropriate — adjust based on measured baseline + headroom.

## File Layout

```
packages/aai-server/
  chaos/
    vitest.chaos.config.ts    # Vitest config: long timeout, sequential, forks pool
    setup.ts                  # testcontainers compose lifecycle + test agent deploy
    helpers.ts                # WS flood, memory sampler, deploy helper utilities
    connection-flood.test.ts  # Test 1
    sandbox-storm.test.ts     # Test 2
    leak-cycle.test.ts        # Test 3
  constants.ts                # + MAX_CONNECTIONS, MAX_SLOTS
  orchestrator.ts             # + connection counter, reject at cap
  sandbox-slots.ts            # + slot cap check, configurable idle timeout

docker-compose.yml            # Moved to repo root from .worktrees/docker-dev/, + mem_limit
package.json                  # + "docker:up", "test:chaos" scripts
```

## New Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `docker:up` | `docker compose up --build` | Start server + MinIO locally |
| `docker:down` | `docker compose down -v` | Stop and clean up |
| `test:chaos` | `vitest run -c packages/aai-server/chaos/vitest.chaos.config.ts` | Run chaos test suite |

## Out of Scope

These are real resilience gaps but separate concerns from OOM:
- **Health readiness checks** (S3 connectivity) — separate PR
- **S3 retry logic** — separate PR
- **Graceful shutdown drain** — separate PR
- **Structured logging / metrics** — separate PR
- **Request rate limiting** — separate concern, defense-in-depth

## Success Criteria

1. All three chaos tests pass against the Docker container with memory limits
2. Server rejects excess connections/sandboxes with back-pressure (no OOM kill)
3. Memory returns to baseline after load cycles (no leaks)
4. Health endpoint stays responsive under stress
5. Existing connections/sessions are unaffected when limits are hit
