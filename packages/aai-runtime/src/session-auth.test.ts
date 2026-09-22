// Copyright 2026 the AAI authors. MIT license.
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { makeClientSink, silentLogger } from "./_test-utils.ts";
import { type AgentServer, createRuntimeServer, type SessionRuntime } from "./server.ts";
import {
  createSessionToken,
  presentedSessionToken,
  resolveSessionGate,
  SESSION_AUTH_PROTOCOL_PREFIX,
  SESSION_UNAUTHORIZED_CLOSE_CODE,
  selectSessionProtocol,
  verifySessionToken,
} from "./session-auth.ts";

/**
 * `startHostSession` stubbed to what matters here: it opens a session and
 * reports its id through `startOpts.onSinkCreated`, as the real one does once
 * the tenant's `config` frame arrives. The real one would dial STT/TTS.
 */
const hostStarts = vi.hoisted((): string[] => []);
vi.mock("./host-mode.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./host-mode.ts")>()),
  startHostSession: (
    ws: { send(data: string): void },
    opts: { startOpts?: import("./runtime-types.ts").SessionStartOptions },
  ) => {
    hostStarts.push(opts.startOpts?.resumeFrom ?? "fresh");
    opts.startOpts?.onSinkCreated?.(`host-${hostStarts.length}`, makeClientSink());
    ws.send(JSON.stringify({ type: "hello" }));
  },
}));

const SECRET = "test-secret-with-enough-entropy";
const T0 = Date.UTC(2026, 0, 1);

/** A real `IncomingMessage` carrying only the two members the gate reads. */
function fakeRequest(opts: { url?: string; protocol?: string; origin?: string }) {
  const req = new IncomingMessage(new Socket());
  req.url = opts.url ?? "/websocket";
  if (opts.protocol !== undefined) req.headers["sec-websocket-protocol"] = opts.protocol;
  if (opts.origin !== undefined) req.headers.origin = opts.origin;
  return req;
}

describe("session tickets", () => {
  test("a minted ticket verifies to the identity it carries", () => {
    const token = createSessionToken({
      secret: SECRET,
      sub: "user-1",
      claims: { plan: "pro" },
      now: T0,
    });
    expect(verifySessionToken(token, { secret: SECRET, now: T0 + 1000 })).toEqual({
      sub: "user-1",
      claims: { plan: "pro" },
    });
  });

  test("a ticket signed with another secret is refused", () => {
    const token = createSessionToken({ secret: "other-secret", sub: "user-1", now: T0 });
    expect(verifySessionToken(token, { secret: SECRET, now: T0 })).toBeUndefined();
  });

  test("a tampered payload is refused", () => {
    const token = createSessionToken({ secret: SECRET, sub: "user-1", now: T0 });
    const [, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ v: 1, sub: "admin", iat: T0 / 1000, exp: T0 / 1000 + 60, jti: "x" }),
    ).toString("base64url");
    expect(verifySessionToken(`${forged}.${sig}`, { secret: SECRET, now: T0 })).toBeUndefined();
  });

  test("a ticket expires after its ttl", () => {
    const token = createSessionToken({ secret: SECRET, sub: "u", ttlSeconds: 60, now: T0 });
    expect(verifySessionToken(token, { secret: SECRET, now: T0 + 59_000 })).toBeDefined();
    expect(verifySessionToken(token, { secret: SECRET, now: T0 + 60_000 })).toBeUndefined();
  });

  test("a ticket issued too far in the future is refused", () => {
    const token = createSessionToken({ secret: SECRET, sub: "u", now: T0 + 120_000 });
    expect(verifySessionToken(token, { secret: SECRET, now: T0 })).toBeUndefined();
  });

  test.each(["", "garbage", "a.b.c", "x".repeat(5000)])("malformed ticket %#", (token) => {
    expect(verifySessionToken(token, { secret: SECRET })).toBeUndefined();
  });

  test("a blank secret is refused at both ends rather than signing with nothing", () => {
    expect(() => createSessionToken({ secret: " ", sub: "u" })).toThrow(/blank/);
    expect(() => verifySessionToken("a.b", { secret: "" })).toThrow(/blank/);
  });
});

describe("presentedSessionToken", () => {
  test("reads the subprotocol entry first", () => {
    const req = fakeRequest({
      url: "/websocket?token=from-query",
      protocol: `aai.v1, ${SESSION_AUTH_PROTOCOL_PREFIX}from-protocol`,
    });
    expect(presentedSessionToken(req)).toBe("from-protocol");
  });

  test("falls back to ?token=", () => {
    expect(presentedSessionToken(fakeRequest({ url: "/websocket?token=q" }))).toBe("q");
  });

  test("is empty when nothing is presented", () => {
    expect(presentedSessionToken(fakeRequest({}))).toBe("");
  });
});

describe("selectSessionProtocol", () => {
  test("never echoes a ticket when anything else was offered", () => {
    expect(selectSessionProtocol(new Set([`${SESSION_AUTH_PROTOCOL_PREFIX}t`, "aai.v1"]))).toBe(
      "aai.v1",
    );
  });

  test("answers with the ticket only when it is all that was offered", () => {
    const only = `${SESSION_AUTH_PROTOCOL_PREFIX}t`;
    expect(selectSessionProtocol(new Set([only]))).toBe(only);
  });
});

describe("resolveSessionGate", () => {
  test("is absent when nothing is configured — the upgrade path is unchanged", () => {
    expect(resolveSessionGate(undefined, {}, silentLogger)).toBeUndefined();
    expect(resolveSessionGate({}, undefined, silentLogger)).toBeUndefined();
  });

  test("AAI_SESSION_SECRET in env turns the ticket check on", async () => {
    const gate = resolveSessionGate(undefined, { AAI_SESSION_SECRET: SECRET }, silentLogger);
    expect(await gate?.admits(fakeRequest({}), undefined)).toEqual({
      ok: false,
      reason: "a session ticket is required",
    });
  });

  test("a blank AAI_SESSION_SECRET is read as unset, not as a secret", () => {
    expect(resolveSessionGate(undefined, { AAI_SESSION_SECRET: "" }, silentLogger)).toBeUndefined();
  });

  test("refuses a listed-out Origin and admits a request with none", async () => {
    const gate = resolveSessionGate(
      { allowedOrigins: ["https://app.example.com"] },
      undefined,
      silentLogger,
    );
    expect(
      (await gate?.admits(fakeRequest({ origin: "https://evil.example" }), undefined))?.ok,
    ).toBe(false);
    expect(
      (await gate?.admits(fakeRequest({ origin: "https://app.example.com" }), undefined))?.ok,
    ).toBe(true);
    expect((await gate?.admits(fakeRequest({}), undefined))?.ok).toBe(true);
  });

  test("a custom verifier decides, and a throwing one refuses", async () => {
    const gate = resolveSessionGate(
      {
        verify: (token) => {
          if (token === "boom") throw new Error("idp down");
          return token === "good" ? { sub: "u" } : null;
        },
      },
      undefined,
      silentLogger,
    );
    const admit = (token: string) =>
      gate?.admits(fakeRequest({ url: `/websocket?token=${token}` }), undefined);
    expect((await admit("good"))?.ok).toBe(true);
    expect((await admit("bad"))?.ok).toBe(false);
    expect((await admit("boom"))?.ok).toBe(false);
  });

  describe("resume ownership", () => {
    const gate = resolveSessionGate({ secret: SECRET }, undefined, silentLogger);
    const withTicket = (ticket: string) =>
      fakeRequest({ protocol: `${SESSION_AUTH_PROTOCOL_PREFIX}${ticket}` });
    gate?.recordOwner("sess-alice", { sub: "alice" });

    test("the identity that opened a session may resume it", async () => {
      const ticket = createSessionToken({ secret: SECRET, sub: "alice" });
      expect((await gate?.admits(withTicket(ticket), "sess-alice"))?.ok).toBe(true);
    });

    test("anybody else holding the session id may not", async () => {
      const ticket = createSessionToken({ secret: SECRET, sub: "mallory" });
      expect(await gate?.admits(withTicket(ticket), "sess-alice")).toEqual({
        ok: false,
        reason: "this ticket may not resume that session",
      });
    });

    test("an unknown session is refused unless the ticket names it", async () => {
      const plain = createSessionToken({ secret: SECRET, sub: "bob" });
      expect((await gate?.admits(withTicket(plain), "sess-restarted"))?.ok).toBe(false);
      const named = createSessionToken({ secret: SECRET, sub: "bob", sessionId: "sess-restarted" });
      expect((await gate?.admits(withTicket(named), "sess-restarted"))?.ok).toBe(true);
    });

    test("a resume ticket cannot open a fresh session", async () => {
      const named = createSessionToken({ secret: SECRET, sub: "bob", sessionId: "sess-x" });
      expect((await gate?.admits(withTicket(named), undefined))?.ok).toBe(false);
    });
  });
});

describe("createRuntimeServer with auth", () => {
  let server: AgentServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  /** A runtime that records each session it is handed and says hello. */
  function recordingRuntime(): { runtime: SessionRuntime; started: string[] } {
    const started: string[] = [];
    return {
      started,
      runtime: {
        startSession: (ws, opts) => {
          started.push(opts?.resumeFrom ?? "fresh");
          // What the real runtime does once it has minted the session's id.
          opts?.onSinkCreated?.(`sess-${started.length}`, makeClientSink());
          ws.send(JSON.stringify({ type: "hello" }));
        },
        shutdown: () => Promise.resolve(),
      },
    };
  }

  type Outcome = { opened: boolean; frames: string[]; closeCode: number; protocol: string };

  function dial(path: string, protocols?: string[]): Promise<Outcome> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server?.port}${path}`, protocols);
      const frames: string[] = [];
      let opened = false;
      ws.on("open", () => {
        opened = true;
      });
      ws.on("message", (data) => frames.push(String(data)));
      ws.on("close", (closeCode) => resolve({ opened, frames, closeCode, protocol: ws.protocol }));
      ws.on("error", reject);
      // A session that is ADMITTED stays open; close once its hello arrives.
      ws.on("message", () => {
        if (frames.some((f) => f.includes("hello"))) ws.close(1000);
      });
    });
  }

  test("a session with no ticket is declined with a reason and the 4401 close code", async () => {
    const { runtime, started } = recordingRuntime();
    server = createRuntimeServer({ runtime, logger: silentLogger, auth: { secret: SECRET } });
    await server.listen(0);

    const outcome = await dial("/websocket");
    expect(outcome.closeCode).toBe(SESSION_UNAUTHORIZED_CLOSE_CODE);
    expect(outcome.frames.join("")).toContain("unauthorized: a session ticket is required");
    expect(outcome.frames.join("")).toContain('"fatal":true');
    expect(started).toEqual([]);
  });

  test("a ticket in the subprotocol is admitted, and the ticket is not echoed back", async () => {
    const { runtime, started } = recordingRuntime();
    server = createRuntimeServer({ runtime, logger: silentLogger, auth: { secret: SECRET } });
    await server.listen(0);

    const ticket = createSessionToken({ secret: SECRET, sub: "alice" });
    const outcome = await dial("/websocket", [
      "aai.v1",
      `${SESSION_AUTH_PROTOCOL_PREFIX}${ticket}`,
    ]);
    expect(outcome.frames).toContain(JSON.stringify({ type: "hello" }));
    expect(outcome.protocol).toBe("aai.v1");
    expect(started).toEqual(["fresh"]);
  });

  test("AAI_SESSION_SECRET in env gates the server without an auth option", async () => {
    const { runtime, started } = recordingRuntime();
    server = createRuntimeServer({
      runtime,
      logger: silentLogger,
      env: { AAI_SESSION_SECRET: SECRET },
    });
    await server.listen(0);

    expect((await dial("/websocket")).closeCode).toBe(SESSION_UNAUTHORIZED_CLOSE_CODE);
    const ticket = createSessionToken({ secret: SECRET, sub: "alice" });
    expect((await dial(`/websocket?token=${ticket}`)).frames).toContain(
      JSON.stringify({ type: "hello" }),
    );
    expect(started).toEqual(["fresh"]);
  });

  test("with no auth configured, sessions open exactly as before", async () => {
    const { runtime, started } = recordingRuntime();
    server = createRuntimeServer({ runtime, logger: silentLogger });
    await server.listen(0);

    expect((await dial("/websocket")).frames).toContain(JSON.stringify({ type: "hello" }));
    expect(started).toEqual(["fresh"]);
  });

  test("only the identity that opened a session may resume it through the server", async () => {
    const { runtime, started } = recordingRuntime();
    server = createRuntimeServer({ runtime, logger: silentLogger, auth: { secret: SECRET } });
    await server.listen(0);
    const as = (sub: string) => `token=${createSessionToken({ secret: SECRET, sub })}`;

    await dial(`/websocket?${as("alice")}`);
    const mallory = await dial(`/websocket?sessionId=sess-1&${as("mallory")}`);
    expect(mallory.closeCode).toBe(SESSION_UNAUTHORIZED_CLOSE_CODE);
    const alice = await dial(`/websocket?sessionId=sess-1&${as("alice")}`);
    expect(alice.frames).toContain(JSON.stringify({ type: "hello" }));
    expect(started).toEqual(["fresh", "sess-1"]);
  });

  test("a host-mode session is resumable by the identity that opened it", async () => {
    hostStarts.length = 0;
    const { runtime } = recordingRuntime();
    server = createRuntimeServer({
      runtime,
      logger: silentLogger,
      env: { AAI_ALLOW_HOST: "1", AAI_SESSION_SECRET: SECRET },
    });
    await server.listen(0);
    const as = (sub: string) => `token=${createSessionToken({ secret: SECRET, sub })}`;

    await dial(`/websocket?host=1&${as("alice")}`);
    const mallory = await dial(`/websocket?host=1&sessionId=host-1&${as("mallory")}`);
    expect(mallory.closeCode).toBe(SESSION_UNAUTHORIZED_CLOSE_CODE);
    const alice = await dial(`/websocket?host=1&sessionId=host-1&${as("alice")}`);
    expect(alice.frames).toContain(JSON.stringify({ type: "hello" }));
    expect(hostStarts).toEqual(["fresh", "host-1"]);
  });
});
