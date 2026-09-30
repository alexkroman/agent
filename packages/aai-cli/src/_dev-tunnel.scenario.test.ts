// Copyright 2026 the AAI authors. MIT license.
/**
 * `startQuickTunnel` and the `--on-public-url` hook against real subprocesses.
 *
 * The tunnel is a FAKE `cloudflared` — a node script that prints the banner a
 * real one prints and then behaves as the case needs — because what this
 * module owns is the process handling (spawn, scrape, timeout, exit, SIGTERM),
 * and a real quick tunnel would put Cloudflare's availability into CI.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runPublicUrlHook, startQuickTunnel } from "./_dev-tunnel.ts";

const URL = "https://quiet-river-1a2b.trycloudflare.com";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "aai-tunnel-"));
  dirs.push(dir);
  return dir;
}

/** An executable fake `cloudflared` running `body` (JS), argv in `process.argv`. */
async function fakeCloudflared(body: string): Promise<string> {
  const file = path.join(await scratch(), "cloudflared");
  await writeFile(file, `#!/usr/bin/env node\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

/** Records its argv, prints the banner on stderr, then waits for SIGTERM. */
const HEALTHY = `
const fs = require("node:fs");
fs.writeFileSync(process.env.ARGV_FILE ?? "/dev/null", JSON.stringify(process.argv.slice(2)));
process.stderr.write("INF Requesting new quick Tunnel on trycloudflare.com...\\n");
setTimeout(() => process.stderr.write("INF |  ${URL}  |\\n"), 50);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;

describe("startQuickTunnel", () => {
  test("resolves with the scraped URL, dials the origin, and close() stops it", async () => {
    const argvFile = path.join(await scratch(), "argv.json");
    vi.stubEnv("ARGV_FILE", argvFile);
    const binary = await fakeCloudflared(HEALTHY);
    const tunnel = await startQuickTunnel({ origin: "http://127.0.0.1:4321", binary });
    expect(tunnel.url).toBe(URL);
    expect(JSON.parse(await readFile(argvFile, "utf-8"))).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--url",
      "http://127.0.0.1:4321",
    ]);
    await tunnel.close();
    expect(await tunnel.exited).toBe(0);
  });

  test("a binary that cannot be started is tunnel_unavailable, naming the fix", async () => {
    const binary = path.join(await scratch(), "no-such-cloudflared");
    await expect(startQuickTunnel({ origin: "http://127.0.0.1:1", binary })).rejects.toMatchObject({
      code: "tunnel_unavailable",
      hint: expect.stringContaining("AAI_CLOUDFLARED_PATH"),
    });
  });

  test("exiting before a URL is tunnel_failed, quoting what it said", async () => {
    const binary = await fakeCloudflared(
      'process.stderr.write("ERR failed to request quick Tunnel: Post \\"https://api.trycloudflare.com/tunnel\\"\\n"); process.exit(1);',
    );
    await expect(startQuickTunnel({ origin: "http://127.0.0.1:1", binary })).rejects.toMatchObject({
      code: "tunnel_failed",
      hint: expect.stringContaining("failed to request quick Tunnel"),
    });
  });

  test("silence past the timeout is tunnel_failed, and the child is stopped", async () => {
    const pidFile = path.join(await scratch(), "pid");
    const binary = await fakeCloudflared(
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    await expect(
      startQuickTunnel({ origin: "http://127.0.0.1:1", binary, timeoutMs: 500 }),
    ).rejects.toMatchObject({ code: "tunnel_failed" });
    const pid = Number(await readFile(pidFile, "utf-8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("runPublicUrlHook", () => {
  test("runs through the shell with PUBLIC_URL and AAI_PUBLIC_URL, and reports the exit", async () => {
    const dir = await scratch();
    const code = await runPublicUrlHook(
      'printf "%s|%s|%s" "$PUBLIC_URL" "$AAI_PUBLIC_URL" "$PWD" > out.txt; exit 3',
      URL,
      { cwd: dir },
    );
    expect(code).toBe(3);
    const [publicUrl, alias, cwd] = (await readFile(path.join(dir, "out.txt"), "utf-8")).split("|");
    expect(publicUrl).toBe(URL);
    expect(alias).toBe(URL);
    expect(path.basename(cwd ?? "")).toBe(path.basename(dir));
  });

  test("the shutdown run gets an EMPTY URL, and a hung hook is cut off", async () => {
    const dir = await scratch();
    expect(await runPublicUrlHook('printf "[%s]" "$PUBLIC_URL" > out.txt', "", { cwd: dir })).toBe(
      0,
    );
    expect(await readFile(path.join(dir, "out.txt"), "utf-8")).toBe("[]");
    expect(await runPublicUrlHook("sleep 30", "", { cwd: dir, timeoutMs: 300 })).toBeNull();
  });
});
