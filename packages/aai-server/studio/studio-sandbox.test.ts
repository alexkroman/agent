// Copyright 2025 the AAI authors. MIT license.

import type { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { createTestConn, makeWarm } from "../_sandbox-vm-test-utils.ts";
import type { WarmHarness } from "../sandbox-vm.ts";
import { createStudioSandbox } from "./studio-sandbox.ts";

/** Auto-respond to bundle/load and tool/execute like a live harness would. */
function autorespond(
  hostWritable: PassThrough,
  hostReadable: PassThrough,
  results: { load?: unknown; tool?: unknown },
): void {
  const respond = (line: string) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.id == null || !msg.method) return;
    const table: Record<string, unknown> = {
      "bundle/load": results.load ?? { ok: true },
      "tool/execute": results.tool ?? { result: "ok" },
    };
    const result = table[msg.method];
    if (result !== undefined) {
      hostReadable.push(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
    }
  };
  hostWritable.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) respond(line);
  });
}

function makeFixture(results: { load?: unknown; tool?: unknown } = {}) {
  const { conn, hostReadable, hostWritable, writtenLines } = createTestConn();
  autorespond(hostWritable, hostReadable, results);
  const cleanup = vi.fn().mockResolvedValue(undefined);
  const warm = makeWarm(conn, cleanup);
  const spawn = vi.fn(async () => warm);
  return { spawn, cleanup, warm, writtenLines, hostReadable, hostWritable };
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

  test("executeTool returns results and formats guest errors", async () => {
    const okFixture = makeFixture({ tool: { result: "rolled 6" } });
    const sandbox = await createStudioSandbox({
      harnessPath: "/tmp/h.mjs",
      spawn: okFixture.spawn,
    });
    expect(await sandbox.executeTool("roll_dice", { count: 1 })).toBe("rolled 6");
    await sandbox.dispose();

    const errFixture = makeFixture({ tool: { error: "kaboom" } });
    const failing = await createStudioSandbox({
      harnessPath: "/tmp/h.mjs",
      spawn: errFixture.spawn,
    });
    expect(await failing.executeTool("roll_dice", {})).toBe("Tool error: kaboom");
    await failing.dispose();
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

  test("registers scratch KV handlers so trial tool runs can use ctx.kv", async () => {
    const fixture = makeFixture();
    const sandbox = await createStudioSandbox({
      harnessPath: "/tmp/h.mjs",
      spawn: fixture.spawn,
    });
    // Simulate the guest issuing kv/set then kv/get.
    fixture.hostReadable.push(
      `${JSON.stringify({ jsonrpc: "2.0", id: 900, method: "kv/set", params: { key: "a", value: 1 } })}\n`,
    );
    fixture.hostReadable.push(
      `${JSON.stringify({ jsonrpc: "2.0", id: 901, method: "kv/get", params: { key: "a" } })}\n`,
    );
    await vi.waitFor(() => {
      const reply = fixture.writtenLines
        .map((l) => JSON.parse(l))
        .find((m: { id?: number }) => m.id === 901);
      expect(reply?.result).toBe(1);
    });
    await sandbox.dispose();
  });
});
