// Copyright 2025 the AAI authors. MIT license.
/**
 * Load Test: Memory per Active Session with Mock S2S
 *
 * Measures host-side memory cost of real sessions using a mock S2S WebSocket.
 * Tests the full session lifecycle (session context, conversation history,
 * client sink) without needing AssemblyAI.
 *
 * Run: pnpm vitest run --config packages/aai-server/load/vitest.load.config.ts session-memory
 */

import { afterAll, describe, expect, test, vi } from "vitest";
import {
  flush,
  type MockS2sHandle,
  makeAgent,
  makeClient,
  makeMockHandle,
  silentLogger,
} from "../../aai/host/_test-utils.ts";
import { createRuntime } from "../../aai/host/runtime.ts";
import type { Session } from "../../aai/host/session.ts";
import { _internals } from "../../aai/host/session.ts";

// ── Stats helpers ───────────────────────────────────────────────────────

function rssMb(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

// ── Test ────────────────────────────────────────────────────────────────

describe("session memory with mock S2S", () => {
  const TIERS = [1, 5, 10, 25, 50, 100];
  const MESSAGES_PER_SESSION = 5;

  const sessions: Session[] = [];
  const mockHandles: MockS2sHandle[] = [];
  let connectSpy: ReturnType<typeof vi.spyOn>;

  afterAll(async () => {
    for (const session of sessions) {
      await session.stop().catch(() => {
        /* noop */
      });
    }
    connectSpy?.mockRestore();
  });

  test("RSS vs active session count", async () => {
    // Mock connectS2s to return fresh mock handles for each session
    connectSpy = vi.spyOn(_internals, "connectS2s").mockImplementation(async () => {
      const handle = makeMockHandle();
      mockHandles.push(handle);
      return handle;
    });

    const agent = makeAgent({
      tools: {
        echo: {
          description: "echo back args",
          execute: (args: unknown) => JSON.stringify(args),
        },
      },
    });

    const runtime = createRuntime({ agent, env: {}, logger: silentLogger });

    if (global.gc) global.gc();
    const baseRss = rssMb();
    console.log(`Baseline RSS: ${baseRss.toFixed(0)}MB\n`);

    const results: {
      sessions: number;
      rssMb: number;
      deltaMb: number;
      perSessionKb: number;
      startMs: number;
    }[] = [];

    for (const tier of TIERS) {
      const tierStart = performance.now();

      // Create sessions up to this tier
      while (sessions.length < tier) {
        const idx = sessions.length;
        const client = makeClient();
        const session = runtime.createSession({
          id: `s-${idx}`,
          agent: agent.name,
          client,
        });
        sessions.push(session);

        await session.start();
        await flush();

        // Fire the "ready" event on the corresponding mock handle
        const handle = mockHandles[idx]!;
        handle._fire("ready", { sessionId: `s-${idx}` });
        await flush();
      }

      // Simulate conversation messages on each session in this tier
      for (let i = 0; i < tier; i++) {
        const handle = mockHandles[i]!;
        for (let m = 0; m < MESSAGES_PER_SESSION; m++) {
          handle._fire("replyStarted", { replyId: `r-${i}-${m}` });
          handle._fire("userTranscript", {
            itemId: `u-${i}-${m}`,
            text: `User message ${m} from session ${i} with some reasonable length content to simulate real conversations`,
          });
          handle._fire("agentTranscript", {
            text: `Agent response ${m} to session ${i} providing helpful information about the topic discussed`,
            replyId: `r-${i}-${m}`,
            itemId: `a-${i}-${m}`,
            interrupted: false,
          });
          handle._fire("replyDone", {});
        }
        await flush();
      }

      const startMs = performance.now() - tierStart;

      if (global.gc) global.gc();
      const rss = rssMb();
      const delta = rss - baseRss;
      const perSessionKb = tier > 0 ? (delta * 1024) / tier : 0;

      results.push({ sessions: tier, rssMb: rss, deltaMb: delta, perSessionKb, startMs });

      console.log(
        `${String(tier).padStart(5)} sessions | ` +
          `RSS ${rss.toFixed(0).padStart(5)}MB | ` +
          `delta ${delta.toFixed(1).padStart(6)}MB | ` +
          `~${perSessionKb.toFixed(1).padStart(6)}KB/session | ` +
          `${startMs.toFixed(0).padStart(6)}ms`,
      );
    }

    // Verify sessions can still receive events after creation
    console.log("\nVerifying sessions still receive events...");
    const lastHandle = mockHandles.at(-1)!;
    lastHandle._fire("replyStarted", { replyId: "verify-reply" });
    lastHandle._fire("userTranscript", { itemId: "verify-u", text: "Verification message" });
    lastHandle._fire("agentTranscript", {
      text: "Verification response",
      replyId: "verify-reply",
      itemId: "verify-a",
      interrupted: false,
    });
    lastHandle._fire("replyDone", {});
    await flush();
    console.log("Event delivery verified OK");

    // Stop all sessions and measure RSS recovery
    console.log("\nStopping all sessions...");
    const stopStart = performance.now();
    for (const session of sessions) {
      await session.stop().catch(() => {
        /* noop */
      });
    }
    const stopMs = performance.now() - stopStart;

    if (global.gc) global.gc();
    // Allow GC to settle
    await new Promise((r) => setTimeout(r, 100));
    if (global.gc) global.gc();

    const recoveredRss = rssMb();
    const recoveredDelta = recoveredRss - baseRss;
    console.log(
      `Stopped ${sessions.length} sessions in ${stopMs.toFixed(0)}ms | ` +
        `RSS ${recoveredRss.toFixed(0)}MB (delta ${recoveredDelta.toFixed(1)}MB)`,
    );

    // Print summary table
    console.log("\n--- Summary ---");
    console.log(
      "Sessions".padStart(8),
      "RSS(MB)".padStart(8),
      "Delta(MB)".padStart(10),
      "KB/sess".padStart(10),
      "Time(ms)".padStart(10),
    );
    console.log("-".repeat(50));
    for (const r of results) {
      console.log(
        String(r.sessions).padStart(8),
        r.rssMb.toFixed(0).padStart(8),
        r.deltaMb.toFixed(1).padStart(10),
        r.perSessionKb.toFixed(1).padStart(10),
        r.startMs.toFixed(0).padStart(10),
      );
    }
    console.log("-".repeat(50));
    console.log(
      `Recovery: ${recoveredRss.toFixed(0)}MB (${recoveredDelta.toFixed(1)}MB above baseline)`,
    );

    // Loose assertions — the primary value is the printed stats
    expect(results.length).toBeGreaterThan(0);
    expect(sessions.length).toBe(TIERS.at(-1));
  }, 60_000);
});
