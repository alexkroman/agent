// Copyright 2026 the AAI authors. MIT license.
import type http from "node:http";
import { ClientConfigResponseSchema } from "@alexkroman1/aai/protocol";
import { createSessionToken, verifySessionToken } from "@alexkroman1/aai-runtime/auth";
import { describe, expect, test } from "vitest";
import { DEV_TICKET_SUB, devSessionTicketing, devTicketVerifier } from "./_dev-session-ticket.ts";

const SECRET = "dev-secret";
const SOURCE = { name: "Support", greeting: "Hi", page: "voice" } as const;

/** A response double that records what the hook wrote. */
function fakeResponse() {
  const out = { status: 0, headers: {} as Record<string, string>, body: "" };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status;
      out.headers = headers;
      return res;
    },
    end(body: string) {
      out.body = body;
    },
  };
  return { res: res as unknown as http.ServerResponse, out };
}

const req = (url: string) => ({ url, headers: {} }) as http.IncomingMessage;

describe("devSessionTicketing", () => {
  test("is off without AAI_SESSION_SECRET, and for a blank one", () => {
    expect(devSessionTicketing({}, SOURCE)).toBeUndefined();
    expect(devSessionTicketing({ AAI_SESSION_SECRET: "  " }, SOURCE)).toBeUndefined();
  });

  test("GET /client-config carries a fresh ticket the secret verifies", () => {
    const ticketing = devSessionTicketing({ AAI_SESSION_SECRET: SECRET }, SOURCE);
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { res, out } = fakeResponse();
      expect(ticketing?.clientConfig(req("/client-config"), res, "/client-config", "GET")).toBe(
        true,
      );
      expect(out.status).toBe(200);
      expect(out.headers["Cache-Control"]).toBe("no-store");
      const body = ClientConfigResponseSchema.parse(JSON.parse(out.body));
      expect(body).toMatchObject({ name: "Support", greeting: "Hi", page: "voice" });
      tokens.push(body.sessionToken ?? "");
    }
    // One per lookup — the client re-fetches per attempt, so each is fresh.
    expect(tokens[0]).not.toBe(tokens[1]);
    for (const token of tokens) {
      expect(verifySessionToken(token, { secret: SECRET })?.sub).toBe(DEV_TICKET_SUB);
    }
  });

  test("answers nothing else", () => {
    const ticketing = devSessionTicketing({ AAI_SESSION_SECRET: SECRET }, SOURCE);
    const { res } = fakeResponse();
    expect(ticketing?.clientConfig(req("/client-config"), res, "/client-config", "POST")).toBe(
      undefined,
    );
    expect(ticketing?.clientConfig(req("/health"), res, "/health", "GET")).toBeUndefined();
  });
});

describe("devTicketVerifier", () => {
  const verify = devTicketVerifier(SECRET);

  test("a valid ticket on a fresh session is its own identity", () => {
    const token = createSessionToken({ secret: SECRET, sub: DEV_TICKET_SUB });
    expect(verify(token, req("/websocket"))).toEqual({ sub: DEV_TICKET_SUB });
  });

  test("a valid ticket on a resume is bound to that session — a rebuilt server admits it", () => {
    const token = createSessionToken({ secret: SECRET, sub: DEV_TICKET_SUB });
    expect(verify(token, req("/websocket?sessionId=sess-1"))).toEqual({
      sub: DEV_TICKET_SUB,
      sessionId: "sess-1",
    });
  });

  test("a ticket under another secret is refused", () => {
    const token = createSessionToken({ secret: "other", sub: DEV_TICKET_SUB });
    expect(verify(token, req("/websocket?sessionId=sess-1"))).toBeUndefined();
  });
});
