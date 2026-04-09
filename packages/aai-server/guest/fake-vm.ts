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

// Clean up stale socket
try {
  fs.unlinkSync(socketPath);
} catch {
  // doesn't exist
}

const server = net.createServer((conn) => {
  // Only accept one connection, then close the server
  server.close();

  // Spawn the Deno harness process with the socket connected to stdin/stdout
  const denoHarnessPath = path.resolve(import.meta.dirname, "deno-harness.ts");
  const harness = spawn("deno", ["run", "--allow-env", "--no-prompt", denoHarnessPath], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  // Connect the socket to the harness stdin/stdout
  if (harness.stdin) {
    conn.pipe(harness.stdin);
  }
  if (harness.stdout) {
    harness.stdout.pipe(conn);
  }

  harness.on("exit", (code) => {
    conn.destroy();
    process.exit(code ?? 0);
  });

  conn.on("error", (err) => {
    console.error("Socket error:", err);
    harness.kill();
    process.exit(1);
  });
});

server.listen(socketPath, () => {
  // Signal ready by writing to stdout (tests can watch for this)
  console.log(`FAKE_VM_READY:${socketPath}`);
});
