// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket integration tests.
 *
 * Starts a real Node HTTP server with native WebSocket upgrade,
 * connects a real WebSocket client, and verifies the full protocol
 * flow end-to-end. Uses a stub session (no real AssemblyAI connection)
 * so the test runs without external dependencies.
 */
import http from "node:http";
import { type Session, type SessionWebSocket, wireSessionSocket } from "@alexkroman1/aai/internal";
import type { ReadyConfig, ServerMessage } from "@alexkroman1/aai/protocol";
import { WebSocketServer } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

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
        wireSessionSocket(ws as unknown as SessionWebSocket, {
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
        captures,
        makeSession: (factory) => {
          if (factory) sessionFactory = factory;
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
  config: ServerMessage;
  messages: ServerMessage[];
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent/websocket`);
    const messages: ServerMessage[] = [];

    ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const data = typeof event.data === "string" ? event.data : String(event.data);
        const msg = JSON.parse(data) as ServerMessage;
        messages.push(msg);
        // Resolve on first message (config)
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

  afterEach(() => {
    ctx.captures.length = 0;
  });

  test("server sends config as first message on connect", async () => {
    const { ws, config } = await connect(ctx.port);
    expect(config).toMatchObject({
      type: "config",
      audioFormat: "pcm16",
      sampleRate: 16_000,
    });
    expect((config as Record<string, unknown>).sessionId).toBeTruthy();
    ws.close();
    await waitForClose(ws);
  });

  test("session.start() is called on connect", async () => {
    const { ws } = await connect(ctx.port);
    await delay(100);
    expect(ctx.captures).toHaveLength(1);
    expect(ctx.captures[0]!.session.start).toHaveBeenCalled();
    ws.close();
    await waitForClose(ws);
  });

  test("audio_ready message triggers session.onAudioReady()", async () => {
    const { ws } = await connect(ctx.port);
    await delay(100);
    ws.send(JSON.stringify({ type: "audio_ready" }));
    await delay(100);
    expect(ctx.captures[0]!.session.onAudioReady).toHaveBeenCalled();
    ws.close();
    await waitForClose(ws);
  });

  test("cancel message triggers session.onCancel()", async () => {
    const { ws } = await connect(ctx.port);
    await delay(100);
    ws.send(JSON.stringify({ type: "cancel" }));
    await delay(100);
    expect(ctx.captures[0]!.session.onCancel).toHaveBeenCalled();
    ws.close();
    await waitForClose(ws);
  });

  test("binary audio data triggers session.onAudio()", async () => {
    const { ws } = await connect(ctx.port);
    await delay(100);
    const pcm = new Uint8Array([1, 2, 3, 4]);
    ws.send(pcm);
    await delay(100);
    expect(ctx.captures[0]!.session.onAudio).toHaveBeenCalled();
    ws.close();
    await waitForClose(ws);
  });

  test("session.stop() is called on client disconnect", async () => {
    const { ws } = await connect(ctx.port);
    await delay(100);
    ws.close();
    await waitForClose(ws);
    await delay(200);
    expect(ctx.captures[0]!.session.stop).toHaveBeenCalled();
  });

  test("multiple concurrent connections get independent sessions", async () => {
    const [c1, c2] = await Promise.all([connect(ctx.port), connect(ctx.port)]);
    await delay(100);
    expect(ctx.captures).toHaveLength(2);
    expect(ctx.captures[0]!.sessionId).not.toBe(ctx.captures[1]!.sessionId);
    c1.ws.close();
    c2.ws.close();
    await Promise.all([waitForClose(c1.ws), waitForClose(c2.ws)]);
  });

  test("session start failure does not crash server", async () => {
    ctx.makeSession(() =>
      makeStubSession({ start: vi.fn(() => Promise.reject(new Error("fail"))) }),
    );
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/agent/websocket`);
    await new Promise<void>((resolve) => {
      ws.addEventListener("open", () => resolve());
    });
    // Should get config before start fails
    await delay(300);
    ws.close();
    await waitForClose(ws);
    // Server should still accept new connections
    ctx.makeSession();
    const { ws: ws2 } = await connect(ctx.port);
    ws2.close();
    await waitForClose(ws2);
  });
});
