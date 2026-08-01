// Copyright 2025 the AAI authors. MIT license.
/**
 * The studio page's CSP has to permit the ONE cross-origin thing the client
 * does: talk straight to the project's guest sandbox (chat + tool labels).
 * A `connect-src` that omits it fails in the browser as a bare
 * "Failed to fetch" with nothing at all on the server, so these tests tie
 * the policy to the URL `chatUrlFromSessionUrl` really produces for each
 * backend rather than to a hand-copied hostname literal.
 */

import { describe, expect, it } from "vitest";
import { chatUrlFromSessionUrl } from "./studio-session-broker.ts";
import { studioCsp } from "./studio-static.ts";

/** The `connect-src` sources from a CSP string. */
function connectSrc(csp: string): string[] {
  const directive = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("connect-src "));
  if (!directive) throw new Error(`no connect-src in: ${csp}`);
  return directive.slice("connect-src ".length).split(/\s+/);
}

/**
 * Approximates the browser's CSP host-source match for a cross-origin URL.
 * `'self'` never matches here — every URL under test is cross-origin by
 * construction (the sandbox is always a different origin than the studio).
 */
function allowsOrigin(csp: string, url: string): boolean {
  const target = new URL(url);
  return connectSrc(csp).some((source) => {
    const m = /^(https?):\/\/(\*\.)?([^:/]+)(?::(\*|\d+))?$/.exec(source);
    if (!m) return false;
    const [, scheme, wildcard, host, port] = m;
    if (`${scheme}:` !== target.protocol) return false;
    if (wildcard ? !target.hostname.endsWith(`.${host}`) : target.hostname !== host) return false;
    return !port || port === "*" || port === target.port;
  });
}

describe("studioCsp", () => {
  it("keeps the restrictive baseline", () => {
    const csp = studioCsp({ SANDBOX_BACKEND: "modal" });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-src 'self'");
    expect(connectSrc(csp)).toContain("'self'");
  });

  it("permits the Modal sandbox chat origin in production", () => {
    const csp = studioCsp({ SANDBOX_BACKEND: "modal" });
    const chatUrl = chatUrlFromSessionUrl("wss://ab12cd-8080.modal.host:443/websocket");
    expect(allowsOrigin(csp, chatUrl)).toBe(true);
  });

  it("permits the loopback sandbox chat origin under apple-container", () => {
    const csp = studioCsp({ SANDBOX_BACKEND: "apple-container" });
    const chatUrl = chatUrlFromSessionUrl("ws://127.0.0.1:55251/websocket");
    expect(allowsOrigin(csp, chatUrl)).toBe(true);
  });

  it("does not permit loopback origins in production", () => {
    const csp = studioCsp({ SANDBOX_BACKEND: "modal" });
    expect(allowsOrigin(csp, "http://127.0.0.1:55251/studio/chat")).toBe(false);
  });

  it("does not permit arbitrary third-party origins", () => {
    for (const backend of ["modal", "apple-container"]) {
      const csp = studioCsp({ SANDBOX_BACKEND: backend });
      expect(allowsOrigin(csp, "https://evil.example.com/studio/chat")).toBe(false);
    }
  });
});
