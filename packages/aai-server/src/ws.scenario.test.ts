// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket scenario tests — a real port, so the scenario tier rather than the
 * in-memory integration one.
 *
 * Starts a real Node HTTP server with native WebSocket upgrade,
 * connects a real WebSocket client, and verifies the full protocol
 * flow end-to-end. Uses a stub session (no real AssemblyAI connection)
 * so the test runs without external dependencies.
 */
import http from "node:http";
import { createOwnedMap } from "@alexkroman1/aai/internal";
import type { ClientSink, ReadyConfig, SessionEvent } from "@alexkroman1/aai/protocol";
import type { SessionCore, SessionWebSocket } from "@alexkroman1/aai-runtime";
import { stampSessionEvent, wireSessionSocket } from "@alexkroman1/aai-runtime/internal";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";

// ── Stub helpers ──────────────────────────────────────────────────────────

/**
 * A stub session that really ANNOUNCES itself.
 *
 * `configure` may not be an inert `vi.fn()`, and that is the one thing about this
 * stub worth stating. The handshake used to be a JSON literal `wireSessionSocket`
 * wrote straight to the socket, so a do-nothing stub still produced a first
 * frame; it is an EVENT now (`session.configured`, stamped and recorded in the
 * retained stream), which means the SESSION sends it. Left inert, every test here
 * hangs waiting for a frame nothing emits — seven of them did, for 120s each,
 * with the timeout naming the test rather than the stub.
 *
 * It stamps through the real `stampSessionEvent`, so the envelope this harness
 * puts on the wire is the one the wire schema requires rather than a
 * hand-written imitation of it.
 */
function makeStubCore(
  sessionId = "stub",
  client?: ClientSink,
  overrides: Partial<SessionCore> = {},
): SessionCore {
  return {
    id: sessionId,
    // No fault: this harness exercises the wire, and a session reporting one
    // would have `ws-handler` log it as degraded rather than ready.
    faultCode: undefined,
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    announce: vi.fn(() => true),
    configure: vi.fn((config: ReadyConfig) => {
      client?.event(stampSessionEvent({ type: "session.configured", ...config, sessionId }));
    }),
    restoreHistory: vi.fn(),
    // Two vocabularies and two audio paths — nineteen `vi.fn()`s before the
    // session's inbound surface became the protocol's own names.
    command: vi.fn(),
    report: vi.fn(),
    onAudio: vi.fn(),
    onAudioChunk: vi.fn(),
    onReplyStarted: vi.fn(),
    ...overrides,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

const READY_CONFIG: ReadyConfig = {
  audioFormat: "pcm16",
  sampleRate: 16_000,
  ttsSampleRate: 24_000,
};

type SessionCapture = { session: SessionCore; sessionId: string };

/** Same shape as `wireSessionSocket`'s own `createSession`, so a test's override
 *  receives the id and the sink the real thing would. */
type SessionFactory = (sessionId: string, client: ClientSink) => SessionCore;

function startTestServer(): Promise<{
  port: number;
  server: http.Server;
  captures: SessionCapture[];
  makeSession: (factory?: SessionFactory) => void;
  close: () => void;
}> {
  return new Promise((resolve) => {
    const captures: SessionCapture[] = [];
    let sessionFactory: SessionFactory = makeStubCore;

    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const sessions = createOwnedMap<string, SessionCore>();
        wireSessionSocket(ws as unknown as SessionWebSocket, {
          sessions,
          createSession: (sid, client) => {
            // The session gets its own id and its own sink, because `configure`
            // now emits through the sink rather than the handler writing JSON.
            const session = sessionFactory(sid, client);
            captures.push({ session, sessionId: sid });
            return session;
          },
          readyConfig: READY_CONFIG,
        });
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        server,
        captures,
        // No argument RESTORES the default, which is the whole reason a test
        // calls it that way. `if (factory) …` made the reset a silent no-op, so
        // a failing factory installed by one case stayed installed and the
        // "server still accepts new connections" check below validated the
        // broken one.
        makeSession: (factory?: SessionFactory) => {
          sessionFactory = factory ?? makeStubCore;
        },
        close: () => {
          server.close();
        },
      });
    });
  });
}

/**
 * Connect a WebSocket and immediately start collecting messages.
 * Returns after the first message (config) is received so there's no race.
 */
function connect(port: number): Promise<{
  ws: WebSocket;
  config: SessionEvent;
  messages: SessionEvent[];
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent/websocket`);
    const messages: SessionEvent[] = [];

    ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const data = typeof event.data === "string" ? event.data : String(event.data);
        const msg = JSON.parse(data) as SessionEvent;
        messages.push(msg);
        if (messages.length === 1) {
          resolve({ ws, config: msg, messages });
        }
      } catch {
        // binary frame — ignore in message collection
      }
    });

    ws.addEventListener("error", () => reject(new Error("WebSocket error")));

    // Timeout safety — cleared on success to avoid dangling handles
    const timer = setTimeout(() => reject(new Error("connect timeout")), 5000);
    ws.addEventListener("open", () => clearTimeout(timer));
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.addEventListener("close", () => resolve());
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("WebSocket server integration", () => {
  let ctx: Awaited<ReturnType<typeof startTestServer>>;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(() => {
    ctx.close();
  });

  afterEach(() => {
    ctx.captures.length = 0;
  });

  test("server sends session.configured as first message on connect", async () => {
    const { ws, config } = await connect(ctx.port);
    expect(config).toMatchObject({
      type: "session.configured",
      audioFormat: "pcm16",
      sampleRate: 16_000,
    });
    // The envelope is part of the frame now, not decoration: a reader keys on
    // `meta.id`, so an event without one is not a session event at all.
    expect(config.meta?.id).toBeTruthy();
    expect((config as Record<string, unknown>).sessionId).toBeTruthy();
    ws.close();
    await waitForClose(ws);
  });

  test("session.start() is called on connect", async () => {
    const { ws } = await connect(ctx.port);
    await vi.waitFor(() => {
      expect(ctx.captures).toHaveLength(1);
      expect(ctx.captures[0]?.session.start).toHaveBeenCalled();
    });
    ws.close();
    await waitForClose(ws);
  });

  test("audio_ready message reaches the session as an `audio_ready` command", async () => {
    const { ws } = await connect(ctx.port);
    await vi.waitFor(() => {
      expect(ctx.captures).toHaveLength(1);
    });
    ws.send(JSON.stringify({ type: "audio_ready" }));
    await vi.waitFor(() => {
      expect(ctx.captures[0]?.session.command).toHaveBeenCalledWith({ type: "audio_ready" });
    });
    ws.close();
    await waitForClose(ws);
  });

  test("cancel message reaches the session as a `cancel` command", async () => {
    const { ws } = await connect(ctx.port);
    await vi.waitFor(() => {
      expect(ctx.captures).toHaveLength(1);
    });
    ws.send(JSON.stringify({ type: "cancel" }));
    await vi.waitFor(() => {
      expect(ctx.captures[0]?.session.command).toHaveBeenCalledWith({ type: "cancel" });
    });
    ws.close();
    await waitForClose(ws);
  });

  test("binary audio data triggers session.onAudio()", async () => {
    const { ws } = await connect(ctx.port);
    await vi.waitFor(() => {
      expect(ctx.captures).toHaveLength(1);
    });
    const pcm = new Uint8Array([1, 2, 3, 4]);
    ws.send(pcm);
    await vi.waitFor(() => {
      expect(ctx.captures[0]?.session.onAudio).toHaveBeenCalled();
    });
    ws.close();
    await waitForClose(ws);
  });

  test("session.stop() is called on client disconnect", async () => {
    const { ws } = await connect(ctx.port);
    await vi.waitFor(() => {
      expect(ctx.captures).toHaveLength(1);
    });
    ws.close();
    await waitForClose(ws);
    await vi.waitFor(() => {
      expect(ctx.captures[0]?.session.stop).toHaveBeenCalled();
    });
  });

  test("multiple concurrent connections get independent sessions", async () => {
    const [c1, c2] = await Promise.all([connect(ctx.port), connect(ctx.port)]);
    await vi.waitFor(() => {
      expect(ctx.captures).toHaveLength(2);
    });
    expect(ctx.captures[0]?.sessionId).not.toBe(ctx.captures[1]?.sessionId);
    c1.ws.close();
    c2.ws.close();
    await Promise.all([waitForClose(c1.ws), waitForClose(c2.ws)]);
  });

  test("session start failure does not crash server", async () => {
    ctx.makeSession((sid, client) =>
      makeStubCore(sid, client, { start: vi.fn(() => Promise.reject(new Error("fail"))) }),
    );
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/agent/websocket`);
    await new Promise<void>((resolve) => {
      ws.addEventListener("open", () => resolve());
    });
    // Wait for the connection to be established and processed
    await vi.waitFor(() => {
      expect(ctx.captures).toHaveLength(1);
    });
    ws.close();
    await waitForClose(ws);
    // Server should still accept new connections — with a HEALTHY session, so
    // this reads the recovery rather than the failure a second time.
    ctx.makeSession();
    ctx.captures.length = 0;
    const { ws: ws2 } = await connect(ctx.port);
    await vi.waitFor(() => {
      expect(ctx.captures).toHaveLength(1);
      expect(ctx.captures[0]?.session.start).toHaveBeenCalled();
    });
    // The restored factory is the healthy DEFAULT rather than the rejecting one
    // installed above — which is the claim the silent no-op reset hid.
    await expect(ctx.captures[0]?.session.start()).resolves.toBeUndefined();
    ws2.close();
    await waitForClose(ws2);
  });
});
