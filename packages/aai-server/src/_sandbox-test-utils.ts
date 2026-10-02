// Copyright 2025 the AAI authors. MIT license.

/** Fakes for a running guest: a {@link Sandbox} and a spawned agent server. */

import { vi } from "vitest";
import { emptyLogPage } from "./agent-logs.ts";
import type { Sandbox } from "./sandbox.ts";
import type { AgentServerHandle } from "./warm-harness.ts";

/**
 * A live fake {@link Sandbox} — resolved URLs on the standard test tunnel, and
 * every lifecycle method a no-op spy. Overrides are spread last, so a sandbox
 * stuck on boot replaces just `sessionUrl`/`guestOrigin`.
 */
export function fakeSandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    sessionUrl: vi.fn(() => Promise.resolve("wss://tunnel.test:443/websocket")),
    guestOrigin: vi.fn(() => Promise.resolve("wss://tunnel.test:443")),
    drain: vi.fn(() => Promise.resolve()),
    logs: vi.fn(() => Promise.resolve(emptyLogPage())),
    alive: vi.fn(() => true),
    shutdown: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

/**
 * A resolved {@link AgentServerHandle}: a guest that booted, holds no sessions,
 * and answers every management call. Typed, so a new field is an error here.
 * Overrides are spread last (a busy or dead guest replaces
 * `activeSessions`/`alive`).
 *
 * A suite faking `spawnAgentServer` (the `spawnAgentServer` option on
 * `SandboxOptions` / `ResolveSandboxOpts` / `OrchestratorOpts`) arms this in a
 * `beforeEach`: a module-level `vi.fn()` is never reset by `restoreMocks`.
 */
export function spawnedAgent(overrides: Partial<AgentServerHandle> = {}): AgentServerHandle {
  return {
    sessionUrl: "wss://tunnel.test:443/websocket",
    guestOrigin: "wss://tunnel.test:443",
    activeSessions: vi.fn(() => Promise.resolve(0)),
    drain: vi.fn(() => Promise.resolve()),
    logs: vi.fn(() => Promise.resolve(emptyLogPage())),
    alive: () => true,
    onExit: vi.fn(),
    shutdown: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}
