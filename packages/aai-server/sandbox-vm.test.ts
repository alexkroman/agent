// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for the sandbox-vm layer: the agent-server spawn dispatch (deployed
 * agents — the HTTP-only contract), and the studio-side warm-harness
 * acquisition + deploy-time bundle inspection that stay on the control
 * channel. The Modal spawn backend is covered by modal-sandbox.test.ts;
 * shared helpers live in _sandbox-vm-test-utils.ts.
 */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  autorespondBundleLoadError,
  baseOpts,
  createTestConn,
  makeWarm,
} from "./_sandbox-vm-test-utils.ts";
import {
  acquireWarmHarness,
  describeBundle,
  spawnAgentServer,
  type WarmHarness,
} from "./sandbox-vm.ts";
import type { AgentServerHandle } from "./warm-harness.ts";

// ── spawnAgentServer dispatch ────────────────────────────────────────────────

function fakeHandle(): AgentServerHandle {
  return {
    sessionUrl: "wss://tunnel.test:443/websocket",
    activeSessions: vi.fn(async () => 0),
    drain: vi.fn(async () => undefined),
    alive: () => true,
    onExit: () => undefined,
    shutdown: vi.fn(async () => undefined),
  };
}

describe("spawnAgentServer", () => {
  it("dispatches to the backend with the worker hash computed for the guest to verify", async () => {
    const handle = fakeHandle();
    const subprocess = vi.fn(async () => handle);
    const modal = vi.fn(async () => handle);
    const opts = baseOpts({ imageTag: "aai-guest-harness:abcd1234" });

    // Test env resolves the subprocess backend (no SUPABASE_S3_ENDPOINT).
    const result = await spawnAgentServer(opts, { modal, subprocess });

    expect(result).toBe(handle);
    expect(modal).not.toHaveBeenCalled();
    expect(subprocess).toHaveBeenCalledWith({
      harnessPath: opts.harnessPath,
      slug: opts.slug,
      workerCode: opts.workerCode,
      workerSha256: createHash("sha256").update(opts.workerCode, "utf-8").digest("hex"),
      agentEnv: opts.env,
    });
  });
});

// ── Warm-harness acquisition (studio/inspect) ────────────────────────────────

describe("acquireWarmHarness", () => {
  it("acquireWarmHarness re-tags a pooled harness with the caller's role", async () => {
    const { conn } = createTestConn();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const setTags = vi.fn().mockResolvedValue(undefined);
    const warm = { ...makeWarm(conn, cleanup), setTags };
    const pool = { acquire: vi.fn(async (): Promise<WarmHarness | null> => warm) };
    const spawn = vi.fn(async (): Promise<WarmHarness> => {
      throw new Error("unexpected cold spawn");
    });

    const acquired = await acquireWarmHarness(
      { pool, harnessPath: "/tmp/harness.mjs", slug: "my-project", role: "studio" },
      spawn,
    );

    expect(acquired).toBe(warm);
    expect(spawn).not.toHaveBeenCalled();
    expect(setTags).toHaveBeenCalledWith({
      service: "aai-guest",
      role: "studio",
      slug: "my-project",
    });
    acquired.conn.dispose();
  });
});

// ── describeBundle ───────────────────────────────────────────────────────────

describe("describeBundle", () => {
  function makeInspectFixture(loadResult: unknown) {
    const { conn, socket, writtenLines } = createTestConn();
    socket.onSend((msg) => {
      if (msg.method === "bundle/load" && msg.id != null) {
        socket.receive({ jsonrpc: "2.0", id: msg.id, result: loadResult });
      }
    });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const warm = makeWarm(conn, cleanup);
    const spawn = vi.fn(async () => warm);
    return { spawn, cleanup, writtenLines, warm };
  }

  it("loads the bundle in a scratch harness and returns its config", async () => {
    const fixture = makeInspectFixture({ ok: true, config: { name: "studio-agent" } });
    const config = await describeBundle(
      { harnessPath: "/tmp/harness.mjs", workerCode: "export default {};" },
      fixture.spawn,
    );
    expect(config).toEqual({ name: "studio-agent" });
    // The harness is always torn down, and a shutdown notification was sent.
    expect(fixture.cleanup).toHaveBeenCalledTimes(1);
    expect(fixture.writtenLines.some((l) => l.includes('"shutdown"'))).toBe(true);
  });

  it("returns undefined for a bundle that does not self-describe", async () => {
    const fixture = makeInspectFixture({ ok: true });
    const config = await describeBundle(
      { harnessPath: "/tmp/harness.mjs", workerCode: "export default {};" },
      fixture.spawn,
    );
    expect(config).toBeUndefined();
  });

  it("tears the harness down even when bundle/load rejects", async () => {
    const { conn, socket } = createTestConn();
    autorespondBundleLoadError(socket);
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const spawn = vi.fn(async () => makeWarm(conn, cleanup));
    await expect(
      describeBundle({ harnessPath: "/tmp/harness.mjs", workerCode: "throw 1" }, spawn),
    ).rejects.toThrow(/Worker code not found/);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
