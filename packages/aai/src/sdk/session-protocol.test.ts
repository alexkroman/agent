// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { SESSION_AUTH_PROTOCOL_PREFIX, SESSION_PROTOCOL } from "./session-protocol.ts";

/** RFC 6455 §4.1: each `Sec-WebSocket-Protocol` entry is an HTTP token. */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

describe("session subprotocols", () => {
  test("both are valid protocol tokens, so a browser's `new WebSocket` accepts them", () => {
    expect(SESSION_PROTOCOL).toMatch(HTTP_TOKEN);
    expect(`${SESSION_AUTH_PROTOCOL_PREFIX}abc.def`).toMatch(HTTP_TOKEN);
  });

  test("the plain protocol is never mistaken for a ticket", () => {
    // A server selects the first offer that is NOT a ticket; were the plain one
    // to start with the prefix, it would select the ticket and echo it back.
    expect(SESSION_PROTOCOL.startsWith(SESSION_AUTH_PROTOCOL_PREFIX)).toBe(false);
  });
});
