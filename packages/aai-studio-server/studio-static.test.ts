// Copyright 2025 the AAI authors. MIT license.
/**
 * The studio page's CSP has to permit the ONE cross-origin thing the client
 * does: talk straight to the project's guest sandbox (chat + tool labels).
 * A `connect-src` that omits it fails in the browser as a bare
 * "Failed to fetch" with nothing at all on the server, so these tests tie
 * the policy to the URL `chatUrlForGuest` really produces for each
 * backend rather than to a hand-copied hostname literal.
 */

import { describe, expect, it } from "vitest";
import { chatUrlForGuest } from "./studio-session-broker.ts";
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
    const chatUrl = chatUrlForGuest("wss://ab12cd-8080.modal.host:443");
    expect(allowsOrigin(csp, chatUrl)).toBe(true);
  });

  it("permits the loopback sandbox chat origin under subprocess", () => {
    const csp = studioCsp({ SANDBOX_BACKEND: "subprocess" });
    const chatUrl = chatUrlForGuest("ws://127.0.0.1:55251");
    expect(allowsOrigin(csp, chatUrl)).toBe(true);
  });

  it("does not permit loopback origins in production", () => {
    const csp = studioCsp({ SANDBOX_BACKEND: "modal" });
    expect(allowsOrigin(csp, "http://127.0.0.1:55251/studio/chat")).toBe(false);
  });

  it("does not permit arbitrary third-party origins", () => {
    for (const backend of ["modal", "subprocess"]) {
      const csp = studioCsp({ SANDBOX_BACKEND: backend });
      expect(allowsOrigin(csp, "https://evil.example.com/studio/chat")).toBe(false);
    }
  });

  // The sign-in leg: supabase-js dials the project origin from the page, so a
  // connect-src without it fails as the same bare "Failed to fetch" — under
  // the email box, with nothing on the server, since no request is ever sent.
  describe("Supabase sign-in origin", () => {
    const supabaseAuth = {
      mode: "supabase",
      supabaseUrl: "https://abc123.supabase.co",
      supabasePublishableKey: "sb_publishable_test",
    } as const;
    const otpUrl = `${supabaseAuth.supabaseUrl}/auth/v1/otp`;

    it("permits the configured project's magic-link endpoint", () => {
      const csp = studioCsp({ SANDBOX_BACKEND: "modal" }, supabaseAuth);
      expect(allowsOrigin(csp, otpUrl)).toBe(true);
    });

    it("permits only that project, not every Supabase project", () => {
      const csp = studioCsp({ SANDBOX_BACKEND: "modal" }, supabaseAuth);
      expect(allowsOrigin(csp, "https://someoneelse.supabase.co/auth/v1/otp")).toBe(false);
    });

    it("tolerates a trailing slash on the configured URL", () => {
      const csp = studioCsp(
        { SANDBOX_BACKEND: "modal" },
        { ...supabaseAuth, supabaseUrl: "https://abc123.supabase.co/" },
      );
      expect(allowsOrigin(csp, otpUrl)).toBe(true);
    });

    it("adds no source for dev auth or an unconfigured login", () => {
      const dev = connectSrc(studioCsp({ SANDBOX_BACKEND: "subprocess" }, { mode: "dev" }));
      expect(dev).toEqual(connectSrc(studioCsp({ SANDBOX_BACKEND: "subprocess" })));
      expect(dev.some((s) => s.includes("supabase"))).toBe(false);
    });

    it("throws on an unparsable URL rather than silently omitting it", () => {
      expect(() =>
        studioCsp({ SANDBOX_BACKEND: "modal" }, { ...supabaseAuth, supabaseUrl: "abc123" }),
      ).toThrow(/SUPABASE_URL/);
    });
  });
});
