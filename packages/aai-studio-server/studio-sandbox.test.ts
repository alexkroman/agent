// Copyright 2025 the AAI authors. MIT license.

import type { WarmHarness } from "aai-server/sandbox-vm";
import { createTestConn, type FakeGuestSocket, makeWarm } from "aai-server/test-utils";
import { describe, expect, test, vi } from "vitest";
import { createStudioSandbox } from "./studio-sandbox.ts";

/** Auto-respond to bundle/load and tool/execute like a live harness would. */
function autorespond(socket: FakeGuestSocket, results: { load?: unknown; tool?: unknown }): void {
  socket.onSend((msg) => {
    if (msg.id == null || !msg.method) return;
    const table: Record<string, unknown> = {
      "bundle/load": results.load ?? { ok: true },
      "tool/execute": results.tool ?? { result: "ok", state: {} },
    };
    const result = table[msg.method as string];
    if (result !== undefined) {
      socket.receive({ jsonrpc: "2.0", id: msg.id, result });
    }
  });
}

function makeFixture(results: { load?: unknown; tool?: unknown } = {}) {
  const { conn, socket, writtenLines } = createTestConn();
  autorespond(socket, results);
  const cleanup = vi.fn().mockResolvedValue(undefined);
  const warm = makeWarm(conn, cleanup);
  const spawn = vi.fn(async () => warm);
  return { spawn, cleanup, warm, writtenLines, socket };
}

describe("createStudioSandbox", () => {
  test("spawns via the shared warm-harness path and loads bundles repeatedly", async () => {
    const fixture = makeFixture({ load: { ok: true, config: { name: "A" } } });
    const sandbox = await createStudioSandbox({
      harnessPath: "/tmp/harness.mjs",
      spawn: fixture.spawn,
    });
    expect(fixture.spawn).toHaveBeenCalledWith({
      harnessPath: "/tmp/harness.mjs",
      slug: "studio-session",
    });
    expect(await sandbox.loadBundle("export default {};")).toEqual({ config: { name: "A" } });
    // Reload replaces the bundle — same harness, second bundle/load request.
    await sandbox.loadBundle("export default { v: 2 };");
    const loads = fixture.writtenLines.filter((l) => l.includes("bundle/load"));
    expect(loads).toHaveLength(2);
    await sandbox.dispose();
    expect(fixture.cleanup).toHaveBeenCalledTimes(1);
  });

  test("prefers a pooled harness over a fresh spawn", async () => {
    const fixture = makeFixture();
    const pool = { acquire: vi.fn(async (): Promise<WarmHarness | null> => fixture.warm) };
    const sandbox = await createStudioSandbox({
      pool: pool as never,
      harnessPath: "/tmp/harness.mjs",
      spawn: fixture.spawn,
    });
    expect(pool.acquire).toHaveBeenCalledTimes(1);
    expect(fixture.spawn).not.toHaveBeenCalled();
    await sandbox.dispose();
  });

  test("falls back to spawning when the pool is empty", async () => {
    const fixture = makeFixture();
    const pool = { acquire: vi.fn(async (): Promise<WarmHarness | null> => null) };
    const sandbox = await createStudioSandbox({
      pool: pool as never,
      harnessPath: "/tmp/harness.mjs",
      spawn: fixture.spawn,
    });
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    await sandbox.dispose();
  });

  test("a pooled harness that died before first use falls back to a fresh spawn", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The pooled harness passed the pool's alive() check but its transport is
    // already dead — the same race createSandboxVm handles with a cold spawn.
    const { conn: deadConn } = createTestConn();
    deadConn.dispose();
    const deadCleanup = vi.fn().mockResolvedValue(undefined);
    const pool = {
      acquire: vi.fn(async (): Promise<WarmHarness | null> => makeWarm(deadConn, deadCleanup)),
    };
    const fixture = makeFixture({ load: { ok: true, config: { name: "A" } } });
    const sandbox = await createStudioSandbox({
      pool: pool as never,
      harnessPath: "/tmp/h.mjs",
      spawn: fixture.spawn,
    });

    // First request hits the dead pooled transport, then retries once fresh.
    expect(await sandbox.loadBundle("export default {};")).toEqual({ config: { name: "A" } });
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    expect(deadCleanup).toHaveBeenCalledTimes(1);

    await sandbox.dispose();
    expect(fixture.cleanup).toHaveBeenCalledTimes(1);
  });

  test("the fallback is one-shot: a fresh spawn's failure surfaces", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { conn: deadConn } = createTestConn();
    deadConn.dispose();
    const pool = {
      acquire: vi.fn(
        async (): Promise<WarmHarness | null> =>
          makeWarm(deadConn, vi.fn().mockResolvedValue(undefined)),
      ),
    };
    // The retry's fresh harness is dead too — no second retry.
    const { conn: alsoDead } = createTestConn();
    alsoDead.dispose();
    const spawn = vi.fn(async () => makeWarm(alsoDead, vi.fn().mockResolvedValue(undefined)));
    const sandbox = await createStudioSandbox({
      pool: pool as never,
      harnessPath: "/tmp/h.mjs",
      spawn,
    });
    await expect(sandbox.loadBundle("export default {};")).rejects.toThrow(/disposed/i);
    expect(spawn).toHaveBeenCalledTimes(1);
    await sandbox.dispose();
  });

  test("executeTool returns results and formats guest errors", async () => {
    const okFixture = makeFixture({ tool: { result: "rolled 6", state: {} } });
    const sandbox = await createStudioSandbox({
      harnessPath: "/tmp/h.mjs",
      spawn: okFixture.spawn,
    });
    expect(await sandbox.executeTool("roll_dice", { count: 1 })).toBe("rolled 6");
    await sandbox.dispose();

    const errFixture = makeFixture({ tool: { error: "kaboom", state: {} } });
    const failing = await createStudioSandbox({
      harnessPath: "/tmp/h.mjs",
      spawn: errFixture.spawn,
    });
    expect(await failing.executeTool("roll_dice", {})).toBe("Tool error: kaboom");
    await failing.dispose();
  });

  test("dispose waits for an in-flight request instead of rejecting it", async () => {
    // No auto-responder yet: the guest has not answered, so bundle/load is
    // still in flight when the turn's teardown runs. Before the in-flight
    // guard this rejected with the transport's "Connection disposed", which
    // `test_agent` reported as "Bundle failed to load in the sandbox".
    const { conn, socket, writtenLines } = createTestConn();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const sandbox = await createStudioSandbox({
      harnessPath: "/tmp/h.mjs",
      spawn: async () => makeWarm(conn, cleanup),
    });

    const pending = sandbox.loadBundle("export default {};");
    await vi.waitFor(() => {
      if (!writtenLines.some((l) => l.includes("bundle/load"))) throw new Error("not sent yet");
    });
    const requestId = JSON.parse(writtenLines.find((l) => l.includes("bundle/load")) as string)
      .id as number;

    // Teardown races the request; the guest replies only afterwards.
    const disposing = sandbox.dispose();
    socket.receive({ jsonrpc: "2.0", id: requestId, result: { ok: true, config: { name: "A" } } });

    await expect(pending).resolves.toEqual({ config: { name: "A" } });
    await disposing;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test("a request that starts after dispose reports the teardown, not a transport error", async () => {
    const fixture = makeFixture();
    const sandbox = await createStudioSandbox({
      harnessPath: "/tmp/h.mjs",
      spawn: fixture.spawn,
    });
    await sandbox.dispose();

    // The coding agent reads these strings — "Connection disposed" would read
    // as the user's bundle being broken.
    await expect(sandbox.loadBundle("export default {};")).rejects.toThrow(/chat turn ended/);
    await expect(sandbox.executeTool("roll_dice", {})).rejects.toThrow(/chat turn ended/);
  });

  test("dispose is idempotent and sends a shutdown notification", async () => {
    const fixture = makeFixture();
    const sandbox = await createStudioSandbox({
      harnessPath: "/tmp/h.mjs",
      spawn: fixture.spawn,
    });
    await sandbox.dispose();
    await sandbox.dispose();
    expect(fixture.cleanup).toHaveBeenCalledTimes(1);
    expect(fixture.writtenLines.some((l) => l.includes('"shutdown"'))).toBe(true);
  });
});
