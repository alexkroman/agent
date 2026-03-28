// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket integration tests.
 *
 * Starts a real Node HTTP server with ws-based WebSocket upgrade,
 * connects a real WebSocket client, and verifies the full protocol
 * flow end-to-end. Uses a stub session (no real AssemblyAI connection)
 * so the test runs without external dependencies.
 */
import http from "node:http";
import { type Session, wireSessionSocket } from "@alexkroman1/aai/internal";
import type { ReadyConfig, ServerMessage } from "@alexkroman1/aai/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

// ── Helpers ──────────────────────────────────────────────────────────────

const READY_CONFIG: ReadyConfig = {
  audioFormat: "pcm16",
  sampleRate: 16_000,
  ttsSampleRate: 24_000,
};

function makeStubSession(overrides?: Partial<Session>): Session {
  return {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    onAudio: vi.fn(),
    onAudioReady: vi.fn(),
    onCancel: vi.fn(),
    onReset: vi.fn(),
    onHistory: vi.fn(),
    waitForTurn: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

type SessionCapture = { session: Session; sessionId: string };

function startTestServer(): Promise<{
  port: number;
  server: http.Server;
  wss: WebSocketServer;
  captures: SessionCapture[];
  makeSession: (factory?: () => Session) => void;
  close: () => void;
}> {
  return new Promise((resolve) => {
    const captures: SessionCapture[] = [];
    let sessionFactory: () => Session = makeStubSession;

    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const sessions = new Map<string, Session>();
        wireSessionSocket(ws as unknown as Parameters<typeof wireSessionSocket>[0], {
          sessions,
          createSession: (sid, _client) => {
            const session = sessionFactory();
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
        wss,
        captures,
        makeSession: (factory) => {
          if (factory) sessionFactory = factory;
        },
        close: () => {
          wss.close();
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
  config: ServerMessage;
  messages: ServerMessage[];
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent/websocket`);
    const messages: ServerMessage[] = [];

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as ServerMessage;
        messages.push(msg);
        // Resolve on first message (config)
        if (messages.length === 1) {
          resolve({ ws, config: msg, messages });
        }
      } catch {
        // binary frame — ignore in message collection
      }
    });

    ws.on("error", reject);

    // Timeout safety — cleared on success to avoid dangling handles
    const timer = setTimeout(() => reject(new Error("connect timeout")), 5000);
    ws.on("open", () => clearTimeout(timer));
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.on("close", () => resolve());
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

  afterEach(async () => {
    ctx.captures.length = 0;
    ctx.makeSession(() => makeStubSession());
    // Let pending close handlers drain
    await delay(50);
  });

  test("client receives config message on connect", async () => {
    const { ws, config } = await connect(ctx.port);
    expect(config).toEqual({ type: "config", ...READY_CONFIG, sessionId: expect.any(String) });
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

  test("audio_ready message calls session.onAudioReady", async () => {
    const { ws } = await connect(ctx.port);
    ws.send(JSON.stringify({ type: "audio_ready" }));
    await vi.waitFor(() => {
      expect(ctx.captures[0]?.session.onAudioReady).toHaveBeenCalledOnce();
    });
    ws.close();
    await waitForClose(ws);
  });

  test("cancel message calls session.onCancel", async () => {
    const { ws } = await connect(ctx.port);
    ws.send(JSON.stringify({ type: "cancel" }));
    await vi.waitFor(() => {
      expect(ctx.captures[0]?.session.onCancel).toHaveBeenCalledOnce();
    });
    ws.close();
    await waitForClose(ws);
  });

  test("reset message calls session.onReset", async () => {
    const { ws } = await connect(ctx.port);
    ws.send(JSON.stringify({ type: "reset" }));
    await vi.waitFor(() => {
      expect(ctx.captures[0]?.session.onReset).toHaveBeenCalledOnce();
    });
    ws.close();
    await waitForClose(ws);
  });

  test("history message calls session.onHistory", async () => {
    const { ws } = await connect(ctx.port);
    const messages = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi" },
    ];
    ws.send(JSON.stringify({ type: "history", messages }));
    await vi.waitFor(() => {
      expect(ctx.captures[0]?.session.onHistory).toHaveBeenCalledWith(messages);
    });
    ws.close();
    await waitForClose(ws);
  });

  test("binary data is forwarded to session.onAudio", async () => {
    const { ws } = await connect(ctx.port);
    const audio = Buffer.from([1, 2, 3, 4]);
    ws.send(audio);
    await vi.waitFor(() => {
      expect(ctx.captures[0]?.session.onAudio).toHaveBeenCalledOnce();
    });
    ws.close();
    await waitForClose(ws);
  });

  test("session.stop() is called on client disconnect", async () => {
    const { ws } = await connect(ctx.port);
    await vi.waitFor(() => expect(ctx.captures).toHaveLength(1));
    ws.close();
    await waitForClose(ws);
    await vi.waitFor(() => {
      expect(ctx.captures[0]?.session.stop).toHaveBeenCalled();
    });
  });

  test("invalid JSON is tolerated", async () => {
    const { ws } = await connect(ctx.port);
    ws.send("not-json{{{");
    // Should not crash — send another valid message to confirm
    ws.send(JSON.stringify({ type: "cancel" }));
    await vi.waitFor(() => {
      expect(ctx.captures[0]?.session.onCancel).toHaveBeenCalledOnce();
    });
    ws.close();
    await waitForClose(ws);
  });

  test("unknown message type is tolerated", async () => {
    const { ws } = await connect(ctx.port);
    ws.send(JSON.stringify({ type: "unknown_type" }));
    ws.send(JSON.stringify({ type: "cancel" }));
    await vi.waitFor(() => {
      expect(ctx.captures[0]?.session.onCancel).toHaveBeenCalledOnce();
    });
    ws.close();
    await waitForClose(ws);
  });

  // ── Resilience tests ──────────────────────────────────────────────────

  test("client disconnect during session.start() does not crash", async () => {
    let resolveStart!: () => void;
    ctx.makeSession(() =>
      makeStubSession({
        start: vi.fn(
          () =>
            new Promise<void>((r) => {
              resolveStart = r;
            }),
        ),
      }),
    );

    const { ws } = await connect(ctx.port);
    // Close before start resolves
    ws.close();
    await waitForClose(ws);
    resolveStart();
    await delay(50);
    // No crash
  });

  test("concurrent sessions are isolated", async () => {
    const c1 = await connect(ctx.port);
    const c2 = await connect(ctx.port);

    await vi.waitFor(() => expect(ctx.captures).toHaveLength(2));

    // Each connection creates its own session
    expect(ctx.captures[0]?.sessionId).not.toBe(ctx.captures[1]?.sessionId);
    expect(ctx.captures[0]?.session).not.toBe(ctx.captures[1]?.session);

    // Messages go to the right session
    c1.ws.send(JSON.stringify({ type: "cancel" }));
    await vi.waitFor(() => {
      expect(ctx.captures[0]?.session.onCancel).toHaveBeenCalledOnce();
    });
    expect(ctx.captures[1]?.session.onCancel).not.toHaveBeenCalled();

    c2.ws.send(JSON.stringify({ type: "reset" }));
    await vi.waitFor(() => {
      expect(ctx.captures[1]?.session.onReset).toHaveBeenCalledOnce();
    });
    expect(ctx.captures[0]?.session.onReset).not.toHaveBeenCalled();

    c1.ws.close();
    c2.ws.close();
    await Promise.all([waitForClose(c1.ws), waitForClose(c2.ws)]);
  }, 15_000);

  test("client abrupt close calls session.stop()", async () => {
    let resolveStop!: () => void;
    const stopCalled = new Promise<void>((r) => {
      resolveStop = r;
    });
    ctx.makeSession(() =>
      makeStubSession({
        stop: vi.fn(() => {
          resolveStop();
          return Promise.resolve();
        }),
      }),
    );

    const { ws } = await connect(ctx.port);
    await vi.waitFor(() => expect(ctx.captures).toHaveLength(1));

    ws.close();
    await stopCalled;
    expect(ctx.captures[0]?.session.stop).toHaveBeenCalled();
  });
});
