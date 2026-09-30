// Copyright 2026 the AAI authors. MIT license.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  cloudflaredBinary,
  runPublicUrlHook,
  type SpawnFn,
  scrapeTunnelUrl,
  startQuickTunnel,
} from "./_dev-tunnel.ts";

describe("scrapeTunnelUrl", () => {
  test("finds the URL inside cloudflared's banner box", () => {
    const banner = [
      "2026-09-29T12:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...",
      "2026-09-29T12:00:01Z INF +--------------------------------------------------------+",
      "2026-09-29T12:00:01Z INF |  https://quiet-river-1a2b.trycloudflare.com           |",
      "2026-09-29T12:00:01Z INF +--------------------------------------------------------+",
    ].join("\n");
    expect(scrapeTunnelUrl(banner)).toBe("https://quiet-river-1a2b.trycloudflare.com");
  });

  test("ignores the hosts it names when there is no tunnel yet, or will be none", () => {
    expect(scrapeTunnelUrl("Requesting new quick Tunnel on trycloudflare.com...")).toBeUndefined();
    // What a failed tunnel request logs: the API endpoint, not a tunnel.
    const failed =
      'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp';
    expect(scrapeTunnelUrl(failed)).toBeUndefined();
  });
});

describe("cloudflaredBinary", () => {
  test("AAI_CLOUDFLARED_PATH wins, else the one on PATH", () => {
    expect(cloudflaredBinary({ AAI_CLOUDFLARED_PATH: "/opt/cf" })).toBe("/opt/cf");
    expect(cloudflaredBinary({ AAI_CLOUDFLARED_PATH: "  " })).toBe("cloudflared");
    expect(cloudflaredBinary({})).toBe("cloudflared");
  });
});

const URL = "https://quiet-river-1a2b.trycloudflare.com";

/**
 * A fake child process: output is written by the spec, `kill` exits it. The
 * real-subprocess cases are `_dev-tunnel.scenario.test.ts`; these pin the same
 * process handling in the unit tier.
 */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((signal: NodeJS.Signals) => {
    this.signalCode = signal;
    this.emit("exit", null);
    return true;
  });
  exit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code);
  }
}

function fakeSpawn(child: FakeChild) {
  const spawn = vi.fn(() => child);
  return { spawn, asSpawn: spawn as unknown as SpawnFn };
}

describe("startQuickTunnel (fake child)", () => {
  test("resolves with the URL from stderr, dials the origin, and close() SIGTERMs once", async () => {
    const child = new FakeChild();
    const { spawn, asSpawn } = fakeSpawn(child);
    const started = startQuickTunnel({
      origin: "http://127.0.0.1:4321",
      binary: "cf",
      spawn: asSpawn,
    });
    child.stderr.write("INF Requesting new quick Tunnel on trycloudflare.com...\n");
    child.stderr.write(`INF |  ${URL}  |\n`);
    const tunnel = await started;
    expect(tunnel.url).toBe(URL);
    expect(spawn).toHaveBeenCalledWith(
      "cf",
      ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:4321"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await tunnel.close();
    await tunnel.close();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("ENOENT is tunnel_unavailable; another spawn error passes through", async () => {
    const missing = new FakeChild();
    const started = startQuickTunnel({
      origin: "http://x",
      binary: "cf",
      spawn: fakeSpawn(missing).asSpawn,
    });
    missing.emit("error", Object.assign(new Error("spawn cf ENOENT"), { code: "ENOENT" }));
    await expect(started).rejects.toMatchObject({ code: "tunnel_unavailable" });

    const broken = new FakeChild();
    const other = startQuickTunnel({
      origin: "http://x",
      binary: "cf",
      spawn: fakeSpawn(broken).asSpawn,
    });
    broken.emit("error", Object.assign(new Error("EMFILE"), { code: "EMFILE" }));
    await expect(other).rejects.toThrow("EMFILE");
  });

  test("an exit before a URL is tunnel_failed quoting the output; silence times out", async () => {
    const dies = new FakeChild();
    const started = startQuickTunnel({
      origin: "http://x",
      binary: "cf",
      spawn: fakeSpawn(dies).asSpawn,
    });
    dies.stdout.write("ERR failed to request quick Tunnel\n");
    await new Promise((r) => setImmediate(r));
    dies.exit(1);
    await expect(started).rejects.toMatchObject({
      code: "tunnel_failed",
      hint: expect.stringContaining("failed to request quick Tunnel"),
    });

    const silent = new FakeChild();
    await expect(
      startQuickTunnel({
        origin: "http://x",
        binary: "cf",
        timeoutMs: 5,
        spawn: fakeSpawn(silent).asSpawn,
      }),
    ).rejects.toMatchObject({
      code: "tunnel_failed",
      message: expect.stringContaining("no tunnel URL"),
    });
    expect(silent.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

describe("runPublicUrlHook (fake child)", () => {
  test("runs through the shell with PUBLIC_URL and AAI_PUBLIC_URL, resolving the exit code", async () => {
    const child = new FakeChild();
    const { spawn, asSpawn } = fakeSpawn(child);
    const done = runPublicUrlHook("./publish.sh", URL, { cwd: "/p", spawn: asSpawn });
    child.exit(3);
    expect(await done).toBe(3);
    expect(spawn).toHaveBeenCalledWith(
      "./publish.sh",
      expect.objectContaining({
        cwd: "/p",
        shell: true,
        env: expect.objectContaining({ PUBLIC_URL: URL, AAI_PUBLIC_URL: URL }),
      }),
    );
  });

  test("a hook past its timeout is SIGTERMed and resolves null; a spawn error rejects", async () => {
    const slow = new FakeChild();
    slow.kill.mockImplementation(() => true);
    expect(
      await runPublicUrlHook("x", "", { cwd: "/p", timeoutMs: 5, spawn: fakeSpawn(slow).asSpawn }),
    ).toBeNull();
    expect(slow.kill).toHaveBeenCalledWith("SIGTERM");

    const broken = new FakeChild();
    const done = runPublicUrlHook("x", "", { cwd: "/p", spawn: fakeSpawn(broken).asSpawn });
    broken.emit("error", new Error("spawn /bin/sh EACCES"));
    await expect(done).rejects.toThrow("EACCES");
  });
});
