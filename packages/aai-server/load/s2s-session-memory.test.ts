// Copyright 2025 the AAI authors. MIT license.
/**
 * Load Test: Concurrent Mock S2S Sessions with Conversation History
 *
 * Creates real runtime sessions with mock S2S, then simulates active
 * conversations by accumulating messages. Measures memory growth as
 * conversation history builds up per session.
 *
 * Run: pnpm vitest run --config packages/aai-server/load/vitest.load.config.ts s2s-session-memory
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

describe("S2S session memory with conversation history", () => {
  const SESSION_TIERS = [10, 25, 50];
  const MESSAGE_TIERS = [10, 50, 100];

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

  test("memory growth: sessions x messages matrix", async () => {
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

    const matrix: {
      sessions: number;
      messages: number;
      rssMb: number;
      deltaMb: number;
      perSessionKb: number;
      perMessageBytes: number;
      replayMs: number;
    }[] = [];

    for (const sessionTier of SESSION_TIERS) {
      // Create sessions up to this tier
      while (sessions.length < sessionTier) {
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

      // Track how many messages have been sent to each session
      let messagesSentPerSession = 0;

      for (const msgTier of MESSAGE_TIERS) {
        const replayStart = performance.now();

        // Send messages to fill up to this message tier
        const msgsToSend = msgTier - messagesSentPerSession;
        if (msgsToSend > 0) {
          for (let i = 0; i < sessionTier; i++) {
            const handle = mockHandles[i]!;
            for (let m = messagesSentPerSession; m < msgTier; m++) {
              handle._fire("replyStarted", { replyId: `r-${i}-${m}` });
              handle._fire("event", {
                type: "user_transcript",
                text: `User message ${m} with some reasonable length content to simulate real conversations and measure memory impact`,
              });
              handle._fire("event", {
                type: "agent_transcript",
                text: `Agent response ${m} providing helpful information about the topic discussed in this conversation turn number ${m}`,
                _interrupted: false,
              });
              handle._fire("event", { type: "reply_done" });
            }
          }
          await flush();
          messagesSentPerSession = msgTier;
        }

        const replayMs = performance.now() - replayStart;

        if (global.gc) global.gc();
        const rss = rssMb();
        const delta = rss - baseRss;
        const perSessionKb = sessionTier > 0 ? (delta * 1024) / sessionTier : 0;
        // Each message tier has (user + agent) messages per session = 2 * msgTier * sessionTier total messages
        const totalMessages = 2 * msgTier * sessionTier;
        const perMessageBytes = totalMessages > 0 ? (delta * 1024 * 1024) / totalMessages : 0;

        matrix.push({
          sessions: sessionTier,
          messages: msgTier,
          rssMb: rss,
          deltaMb: delta,
          perSessionKb,
          perMessageBytes,
          replayMs,
        });

        console.log(
          `${String(sessionTier).padStart(4)} sessions x ` +
            `${String(msgTier).padStart(4)} msgs | ` +
            `RSS ${rss.toFixed(0).padStart(5)}MB | ` +
            `delta ${delta.toFixed(1).padStart(6)}MB | ` +
            `~${perSessionKb.toFixed(1).padStart(6)}KB/sess | ` +
            `~${perMessageBytes.toFixed(0).padStart(4)}B/msg | ` +
            `${replayMs.toFixed(0).padStart(6)}ms`,
        );
      }

      // Reset message count for next session tier (messages already sent accumulate)
      // New sessions added in next tier start fresh, but existing ones keep history
    }

    // Stop all sessions and measure recovery
    console.log("\nStopping all sessions...");
    const stopStart = performance.now();
    for (const session of sessions) {
      await session.stop().catch(() => {
        /* noop */
      });
    }
    const stopMs = performance.now() - stopStart;

    if (global.gc) global.gc();
    await new Promise((r) => setTimeout(r, 100));
    if (global.gc) global.gc();

    const recoveredRss = rssMb();
    const recoveredDelta = recoveredRss - baseRss;
    console.log(
      `Stopped ${sessions.length} sessions in ${stopMs.toFixed(0)}ms | ` +
        `RSS ${recoveredRss.toFixed(0)}MB (delta ${recoveredDelta.toFixed(1)}MB)`,
    );

    // Print summary matrix
    console.log("\n--- Sessions x Messages Matrix ---");
    console.log(
      "Sessions".padStart(8),
      "Msgs".padStart(6),
      "RSS(MB)".padStart(8),
      "Delta(MB)".padStart(10),
      "KB/sess".padStart(10),
      "B/msg".padStart(8),
      "Time(ms)".padStart(10),
    );
    console.log("-".repeat(64));
    for (const r of matrix) {
      console.log(
        String(r.sessions).padStart(8),
        String(r.messages).padStart(6),
        r.rssMb.toFixed(0).padStart(8),
        r.deltaMb.toFixed(1).padStart(10),
        r.perSessionKb.toFixed(1).padStart(10),
        r.perMessageBytes.toFixed(0).padStart(8),
        r.replayMs.toFixed(0).padStart(10),
      );
    }
    console.log("-".repeat(64));

    const peak = matrix.at(-1);
    if (peak) {
      console.log(
        `Peak: ${peak.sessions} sessions x ${peak.messages} msgs, ` +
          `RSS +${peak.deltaMb.toFixed(1)}MB, ` +
          `~${peak.perSessionKb.toFixed(1)}KB/sess, ` +
          `~${peak.perMessageBytes.toFixed(0)}B/msg`,
      );
    }
    console.log(
      `Recovery: ${recoveredRss.toFixed(0)}MB (${recoveredDelta.toFixed(1)}MB above baseline)`,
    );

    // Loose assertions — the primary value is the printed stats
    expect(matrix.length).toBe(SESSION_TIERS.length * MESSAGE_TIERS.length);
    expect(sessions.length).toBe(SESSION_TIERS.at(-1));
  }, 60_000);
});
