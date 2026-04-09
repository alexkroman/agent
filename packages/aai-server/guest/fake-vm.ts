/**
 * Fake VM for local testing on macOS (no KVM required).
 *
 * Simulates a Firecracker guest by running the harness in a child process
 * that communicates over a Unix domain socket instead of vsock.
 *
 * The test suite connects to the socket and exercises the full integration
 * path: bundle injection, tool execution, KV proxy, hooks, and shutdown.
 *
 * Usage:
 *   node --experimental-strip-types guest/fake-vm.ts /tmp/test.sock
 *
 * The process:
 * 1. Creates a Unix socket server at the given path
 * 2. Waits for one connection
 * 3. Passes the socket to the guest harness main() function
 * 4. Exits when the harness exits (shutdown message or socket close)
 */

import net from "node:net";
import { main } from "./harness.ts";

const socketPath = process.argv[2];
if (!socketPath) {
  console.error("Usage: fake-vm.ts <socket-path>");
  process.exit(1);
}

// Clean up stale socket
const fs = await import("node:fs");
try {
  fs.unlinkSync(socketPath);
} catch {
  // doesn't exist
}

const server = net.createServer((conn) => {
  // Only accept one connection, then close the server
  server.close();

  // Run the guest harness with this connection as the transport
  main(conn as unknown as import("node:stream").Duplex).catch((err) => {
    console.error("Harness error:", err);
    process.exit(1);
  });
});

server.listen(socketPath, () => {
  // Signal ready by writing to stdout (tests can watch for this)
  console.log(`FAKE_VM_READY:${socketPath}`);
});
