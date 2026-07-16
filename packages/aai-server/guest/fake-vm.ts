/**
 * Fake VM for local testing on macOS (no KVM required).
 *
 * Simulates a gVisor guest by running the Deno harness in a child process
 * that communicates over a Unix domain socket instead of stdio pipes.
 *
 * The test suite connects to the socket and exercises the full integration
 * path: bundle injection, tool execution, KV proxy, and shutdown.
 *
 * Usage:
 *   node --experimental-strip-types guest/fake-vm.ts /tmp/test.sock
 *
 * The process:
 * 1. Creates a Unix socket server at the given path
 * 2. Waits for one connection
 * 3. Spawns the Deno harness with the socket connected to stdin/stdout
 * 4. Exits when the harness exits (shutdown message or socket close)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const socketPath = process.argv[2];
if (!socketPath) {
  console.error("Usage: fake-vm.ts <socket-path>");
  process.exit(1);
}

fs.rmSync(socketPath, { force: true });

const denoHarnessPath = path.resolve(import.meta.dirname, "deno-harness.ts");

const server = net.createServer((conn) => {
  server.close();

  const harness = spawn("deno", ["run", "--allow-env", "--no-prompt", denoHarnessPath], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const { stdin, stdout } = harness;
  if (!(stdin && stdout)) throw new Error("harness stdio missing");

  conn.pipe(stdin);
  stdout.pipe(conn);

  harness.on("exit", (code) => {
    conn.destroy();
    process.exit(code ?? 0);
  });

  // A failed spawn (deno missing) emits `error` with no `exit` guaranteed to
  // follow; exit cleanly instead of dying on an uncaughtException.
  harness.on("error", (err) => {
    console.error("Harness spawn error:", err);
    conn.destroy();
    process.exit(1);
  });

  conn.on("error", (err) => {
    console.error("Socket error:", err);
    harness.kill();
    process.exit(1);
  });
});

server.listen(socketPath, () => {
  console.log(`FAKE_VM_READY:${socketPath}`);
});
