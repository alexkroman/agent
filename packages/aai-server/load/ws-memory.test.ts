// Copyright 2025 the AAI authors. MIT license.
/**
 * Load Test: WebSocket Connection Memory and Upgrade Rate
 *
 * Measures per-WebSocket-connection memory using a real HTTP server
 * with WebSocket upgrade. Opens increasing numbers of connections
 * and measures RSS, per-connection memory delta, and upgrade rate.
 *
 * Run: pnpm vitest run --config packages/aai-server/load/vitest.load.config.ts ws-memory
 */

import http from "node:http";
import { afterAll, describe, expect, test } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

// ── Stats helpers ───────────────────────────────────────────────────────

function rssMb(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

// ── Test ────────────────────────────────────────────────────────────────

describe("WebSocket connection memory", () => {
  const TIERS = [1, 10, 50, 100, 200, 500];

  let server: http.Server;
  let wss: WebSocketServer;
  let port: number;
  const allConnections: WebSocket[] = [];

  afterAll(async () => {
    // Close all client connections
    await Promise.allSettled(
      allConnections.map(
        (ws) =>
          new Promise<void>((resolve) => {
            if (ws.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            ws.on("close", () => resolve());
            ws.close();
          }),
      ),
    );

    // Close server
    wss?.close();
    await new Promise<void>((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });
  });

  test("memory and upgrade rate vs connection count", async () => {
    // Create a minimal HTTP + WebSocket server
    server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    wss = new WebSocketServer({ server });

    // Echo back any message received (keeps connections alive)
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        port = addr.port;
        resolve();
      });
    });

    if (global.gc) global.gc();
    const baseRss = rssMb();
    console.log(`Server listening on port ${port}, baseline RSS: ${baseRss.toFixed(0)}MB\n`);

    const results: {
      connections: number;
      rssMb: number;
      deltaMb: number;
      perConnKb: number;
      upgradeRatePerSec: number;
      connectMs: number;
    }[] = [];

    for (const tier of TIERS) {
      const connectStart = performance.now();
      let newConnections = 0;

      // Open connections up to this tier
      while (allConnections.length < tier) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("Connection timeout"));
          }, 5000);
          ws.on("open", () => {
            clearTimeout(timeout);
            resolve();
          });
          ws.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });
        allConnections.push(ws);
        newConnections++;
      }

      const connectMs = performance.now() - connectStart;
      const upgradeRatePerSec = newConnections > 0 ? newConnections / (connectMs / 1000) : 0;

      if (global.gc) global.gc();
      const rss = rssMb();
      const delta = rss - baseRss;
      const perConnKb = tier > 0 ? (delta * 1024) / tier : 0;

      results.push({
        connections: tier,
        rssMb: rss,
        deltaMb: delta,
        perConnKb,
        upgradeRatePerSec,
        connectMs,
      });

      console.log(
        `${String(tier).padStart(5)} conns | ` +
          `RSS ${rss.toFixed(0).padStart(5)}MB | ` +
          `delta ${delta.toFixed(1).padStart(6)}MB | ` +
          `~${perConnKb.toFixed(1).padStart(6)}KB/conn | ` +
          `${upgradeRatePerSec.toFixed(0).padStart(6)} upgrades/s | ` +
          `${connectMs.toFixed(0).padStart(6)}ms`,
      );

      // Verify connections are alive by sending a ping through one
      if (allConnections.length > 0) {
        const testWs = allConnections.at(-1)!;
        const echoPromise = new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => resolve(false), 2000);
          testWs.once("message", () => {
            clearTimeout(timeout);
            resolve(true);
          });
          testWs.send("ping");
        });
        const alive = await echoPromise;
        if (!alive) {
          console.log(`Warning: connection echo failed at tier ${tier}`);
        }
      }
    }

    // Close all connections and measure RSS recovery
    console.log("\nClosing all connections...");
    const closeStart = performance.now();
    await Promise.allSettled(
      allConnections.map(
        (ws) =>
          new Promise<void>((resolve) => {
            if (ws.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            ws.on("close", () => resolve());
            ws.close();
          }),
      ),
    );
    const closeMs = performance.now() - closeStart;

    if (global.gc) global.gc();
    // Allow GC to settle
    await new Promise((r) => setTimeout(r, 200));
    if (global.gc) global.gc();

    const recoveredRss = rssMb();
    const recoveredDelta = recoveredRss - baseRss;
    console.log(
      `Closed ${allConnections.length} connections in ${closeMs.toFixed(0)}ms | ` +
        `RSS ${recoveredRss.toFixed(0)}MB (delta ${recoveredDelta.toFixed(1)}MB)`,
    );

    // Print summary table
    console.log("\n--- Summary ---");
    console.log(
      "Conns".padStart(6),
      "RSS(MB)".padStart(8),
      "Delta(MB)".padStart(10),
      "KB/conn".padStart(10),
      "Upgr/s".padStart(10),
      "Time(ms)".padStart(10),
    );
    console.log("-".repeat(58));
    for (const r of results) {
      console.log(
        String(r.connections).padStart(6),
        r.rssMb.toFixed(0).padStart(8),
        r.deltaMb.toFixed(1).padStart(10),
        r.perConnKb.toFixed(1).padStart(10),
        r.upgradeRatePerSec.toFixed(0).padStart(10),
        r.connectMs.toFixed(0).padStart(10),
      );
    }

    const peakTier = results.at(-1);
    if (peakTier) {
      console.log("-".repeat(58));
      console.log(
        `Peak: ${peakTier.connections} connections, ` +
          `RSS +${peakTier.deltaMb.toFixed(1)}MB, ` +
          `~${peakTier.perConnKb.toFixed(1)}KB/conn`,
      );
      console.log(
        `Recovery: ${recoveredRss.toFixed(0)}MB (${recoveredDelta.toFixed(1)}MB above baseline)`,
      );
    }

    // Loose assertions
    expect(results.length).toBeGreaterThan(0);
    expect(allConnections.length).toBe(TIERS.at(-1));
  }, 60_000);
});
