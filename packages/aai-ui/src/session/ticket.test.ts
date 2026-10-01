// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
/**
 * The session ticket each connection attempt presents: asked for per attempt
 * (a reconnect gets a FRESH one, told the session it resumes), carried in
 * `Sec-WebSocket-Protocol` beside the plain session protocol, and taken from
 * `client-config` when the caller gave none. Over partysocket with the mock as
 * its transport and a stubbed `fetch` — no network.
 */
import {
  SESSION_AUTH_PROTOCOL_PREFIX,
  SESSION_PROTOCOL,
  SESSION_TICKET_HEADER,
} from "@alexkroman1/aai/protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  lastSocket,
  MockWebSocket,
  MockWebSocketConstructor,
} from "../_session-core-test-utils.ts";
import { createDialer } from "./dial.ts";
import { resolveSessionToken, resolveSessionTokenSync, ticketCarriage } from "./ticket.ts";

const offer = (ticket: string) => [SESSION_PROTOCOL, `${SESSION_AUTH_PROTOCOL_PREFIX}${ticket}`];

describe("ticketCarriage", () => {
  test("no ticket offers no subprotocols at all — the handshake is unchanged", () => {
    expect(ticketCarriage(undefined)).toEqual({});
  });

  test("a ticket rides the subprotocol list AFTER the plain session protocol", () => {
    expect(ticketCarriage("abc.def-_")).toEqual({ protocols: offer("abc.def-_") });
  });

  test("a value that is not a protocol token falls back to ?token=", () => {
    // `new WebSocket(url, ["aai.auth.a b"])` throws a SyntaxError in a browser.
    expect(ticketCarriage("a b")).toEqual({ queryToken: "a b" });
    expect(ticketCarriage("a/b")).toEqual({ queryToken: "a/b" });
  });
});

describe("resolveSessionToken", () => {
  test("a string is trimmed, and blank means none", async () => {
    expect(await resolveSessionToken(" t ", { sessionId: undefined })).toBe("t");
    expect(await resolveSessionToken("  ", { sessionId: undefined })).toBeUndefined();
  });

  test("a getter is told the session the attempt resumes", async () => {
    const getter = vi.fn(
      async ({ sessionId }: { sessionId: string | undefined }) => `for-${sessionId}`,
    );
    expect(await resolveSessionToken(getter, { sessionId: "s1" })).toBe("for-s1");
    expect(getter).toHaveBeenCalledWith({ sessionId: "s1" });
  });

  test("a getter that rejects yields none instead of failing the attempt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = async (): Promise<string> => {
      throw new Error("backend down");
    };
    expect(await resolveSessionToken(failing, { sessionId: undefined })).toBeUndefined();
  });

  test("the synchronous form refuses a Promise rather than sending `[object Promise]`", () => {
    expect(() => resolveSessionTokenSync(async () => "t", { sessionId: undefined })).toThrow(
      TypeError,
    );
    expect(resolveSessionTokenSync(() => "t", { sessionId: undefined })).toBe("t");
  });
});

describe("createDialer with an injected WebSocket", () => {
  beforeEach(() => sessionStorage.clear());

  test("a string token is offered as a subprotocol and kept out of the URL", () => {
    const dialer = createDialer({
      platformUrl: "http://test.local",
      WebSocket: MockWebSocketConstructor,
      token: "ticket",
    });
    dialer.open();
    const socket = lastSocket;
    expect(socket?.protocols).toEqual(offer("ticket"));
    expect(new URL(socket?.url ?? "").searchParams.has("token")).toBe(false);
  });

  test("no token offers no subprotocols", () => {
    const dialer = createDialer({
      platformUrl: "http://test.local",
      WebSocket: MockWebSocketConstructor,
    });
    dialer.open();
    expect(lastSocket?.protocols).toBeUndefined();
  });
});

describe("createDialer over partysocket", () => {
  /** Every socket partysocket constructed, in order. */
  let created: MockWebSocket[] = [];
  /** What each `client-config` lookup answers, in order; the last repeats. */
  let configs: Record<string, unknown>[] = [];
  let lookups = 0;
  /** The ticket each lookup presented in `SESSION_TICKET_HEADER`, in order. */
  let presented: (string | null)[] = [];

  class TrackingWebSocket extends MockWebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols);
      created.push(this);
    }
  }

  async function nextSocket(prevCount: number): Promise<MockWebSocket> {
    for (let i = 0; i < 40 && created.length === prevCount; i++) {
      await vi.advanceTimersByTimeAsync(500);
    }
    const socket = created.at(-1);
    if (created.length === prevCount || !socket) throw new Error("no attempt within 20s");
    return socket;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    created = [];
    configs = [{ page: "voice" }];
    lookups = 0;
    presented = [];
    vi.stubGlobal("WebSocket", TrackingWebSocket);
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      presented.push(new Headers(init?.headers).get(SESSION_TICKET_HEADER));
      const body = configs[Math.min(lookups, configs.length - 1)];
      lookups++;
      return new Response(JSON.stringify(body), { status: 200 });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("a fresh ticket per attempt, and the reconnect's getter is told the session it resumes", async () => {
    const asked: (string | undefined)[] = [];
    const dialer = createDialer({
      platformUrl: "http://test.local",
      token: async ({ sessionId }) => {
        asked.push(sessionId);
        return `ticket-${asked.length}`;
      },
    });
    const ws = dialer.open();
    try {
      const first = await nextSocket(0);
      expect(first.protocols).toEqual(offer("ticket-1"));
      expect(new URL(first.url).searchParams.has("token")).toBe(false);

      first.simulateOpen();
      dialer.configured("sess-1");
      first.simulateClose(1006);

      const second = await nextSocket(1);
      expect(second.protocols).toEqual(offer("ticket-2"));
      expect(new URL(second.url).searchParams.get("sessionId")).toBe("sess-1");
      expect(asked).toEqual([undefined, "sess-1"]);
    } finally {
      ws.close();
    }
  });

  test("with no token option, the ticket client-config issued is used — re-fetched per attempt", async () => {
    configs = [
      { page: "voice", sessionToken: "cfg-1" },
      { page: "voice", sessionToken: "cfg-2" },
    ];
    const dialer = createDialer({ platformUrl: "http://test.local" });
    const ws = dialer.open();
    try {
      const first = await nextSocket(0);
      expect(first.protocols).toEqual(offer("cfg-1"));
      first.simulateClose(1006);
      // A config that issues tickets is NOT latched as "nothing per attempt".
      const second = await nextSocket(1);
      expect(second.protocols).toEqual(offer("cfg-2"));
      expect(lookups).toBe(2);
    } finally {
      ws.close();
    }
  });

  test("the caller's own ticket wins over one client-config issued", async () => {
    configs = [{ page: "voice", sessionToken: "from-server" }];
    const dialer = createDialer({ platformUrl: "http://test.local", token: () => "mine" });
    const ws = dialer.open();
    try {
      expect((await nextSocket(0)).protocols).toEqual(offer("mine"));
    } finally {
      ws.close();
    }
  });

  test("a getter that rejects still dials, with no ticket", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dialer = createDialer({
      platformUrl: "http://test.local",
      token: () => Promise.reject(new Error("backend down")),
    });
    const ws = dialer.open();
    try {
      const first = await nextSocket(0);
      expect(first.protocols).toBeUndefined();
    } finally {
      ws.close();
    }
  });

  test("a config that names neither a broker nor a ticket is latched, as before", async () => {
    const dialer = createDialer({ platformUrl: "http://test.local", token: "t" });
    const ws = dialer.open();
    try {
      const first = await nextSocket(0);
      first.simulateClose(1006);
      const second = await nextSocket(1);
      expect(second.protocols).toEqual(offer("t"));
      expect(lookups).toBe(1);
    } finally {
      ws.close();
    }
  });
  describe("ticket() — the ticket another socket (the inbox) presents", () => {
    test("is the token option when there is one", async () => {
      expect(createDialer({ platformUrl: "http://test.local", token: " t " }).ticket()).toBe("t");
      const getter = createDialer({ platformUrl: "http://test.local", token: async () => "g" });
      expect(await getter.ticket()).toBe("g");
      expect(lookups).toBe(0);
    });

    test("else a FRESH one from client-config on every call", async () => {
      configs = [
        { page: "voice", sessionToken: "c1" },
        { page: "voice", sessionToken: "c2" },
      ];
      const dialer = createDialer({ platformUrl: "http://test.local" });
      expect(await dialer.ticket()).toBe("c1");
      expect(await dialer.ticket()).toBe("c2");
    });

    test("and none, without asking again, once the server is seen to issue none", async () => {
      const dialer = createDialer({ platformUrl: "http://test.local" });
      expect(await dialer.ticket()).toBeUndefined();
      expect(dialer.ticket()).toBeUndefined();
      expect(lookups).toBe(1);
    });
  });

  describe("a server-issued ticket is the resume credential (the managed platform)", () => {
    const broker = (n: number) => ({
      page: "voice",
      sessionUrl: "wss://sandbox.test/websocket",
      sessionToken: `minted-${n}`,
    });

    test("a resume presents the LAST ticket the server issued; a new session presents none", async () => {
      configs = [broker(1), broker(2)];
      const dialer = createDialer({ platformUrl: "https://platform.test/agent/" });
      const ws = dialer.open();
      try {
        const first = await nextSocket(0);
        expect(first.protocols).toEqual(offer("minted-1"));
        first.simulateOpen();
        dialer.configured("sess-1");
        first.simulateClose(1006);
        const second = await nextSocket(1);
        expect(second.protocols).toEqual(offer("minted-2"));
        expect(presented).toEqual([null, "minted-1"]);
      } finally {
        ws.close();
      }
    });

    test("a reload presents the stored ticket beside the stored session id", async () => {
      configs = [broker(1), broker(2)];
      const platformUrl = "https://platform.test/agent/";
      const before = createDialer({ platformUrl });
      const ws1 = before.open();
      const first = await nextSocket(0);
      first.simulateOpen();
      before.configured("sess-1");
      ws1.close();

      const after = createDialer({ platformUrl });
      const ws2 = after.open();
      try {
        await nextSocket(1);
        expect(presented.at(-1)).toBe("minted-1");
      } finally {
        ws2.close();
      }
    });

    test("forget() drops the ticket with the session", async () => {
      configs = [broker(1), broker(2)];
      const platformUrl = "https://platform.test/agent/";
      const dialer = createDialer({ platformUrl });
      const ws = dialer.open();
      const first = await nextSocket(0);
      first.simulateOpen();
      dialer.configured("sess-1");
      ws.close();
      dialer.forget();

      // Even resuming that id by hand: the ticket that proved it is gone.
      const fresh = createDialer({ platformUrl, resumeSessionId: "sess-1" });
      const ws2 = fresh.open();
      try {
        await nextSocket(1);
        expect(presented.at(-1)).toBeNull();
      } finally {
        ws2.close();
      }
    });
  });
});
