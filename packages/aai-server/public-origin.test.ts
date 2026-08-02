// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { publicForwardedHeaders, resolvePublicOrigin } from "./public-origin.ts";

/** A request as the app sees it behind Modal: cleartext, public Host header. */
function behindTls(path = "/deploy", headers: Record<string, string> = {}): Request {
  return new Request(`http://agent.example.modal.run${path}`, { headers });
}

describe("resolvePublicOrigin", () => {
  test("a public host reached over cleartext resolves to https", () => {
    // The regression: Modal forwards plain HTTP to the container and sets no
    // x-forwarded-proto, so trusting the request URL published http:// — and
    // the guest's deploy POST lost its Authorization header on the redirect.
    expect(resolvePublicOrigin(behindTls(), {})).toBe("https://agent.example.modal.run");
  });

  test("loopback stays http (aai dev, local combined runs, tests)", () => {
    expect(resolvePublicOrigin(new Request("http://localhost:8080/deploy"), {})).toBe(
      "http://localhost:8080",
    );
    expect(resolvePublicOrigin(new Request("http://127.0.0.1:3000/deploy"), {})).toBe(
      "http://127.0.0.1:3000",
    );
  });

  test("an explicit x-forwarded-proto/host wins over inference", () => {
    const req = behindTls("/deploy", {
      "x-forwarded-proto": "http",
      "x-forwarded-host": "internal.test:9000",
    });
    expect(resolvePublicOrigin(req, {})).toBe("http://internal.test:9000");
  });

  test("only the first hop of a forwarded chain is used", () => {
    const req = behindTls("/deploy", {
      "x-forwarded-proto": "https, http",
      "x-forwarded-host": "public.test, inner.test",
    });
    expect(resolvePublicOrigin(req, {})).toBe("https://public.test");
  });

  test("AAI_PUBLIC_ORIGIN overrides everything, trailing slash stripped", () => {
    const req = behindTls("/deploy", { "x-forwarded-proto": "http" });
    expect(resolvePublicOrigin(req, { AAI_PUBLIC_ORIGIN: "https://aai.example/" })).toBe(
      "https://aai.example",
    );
  });

  test("a blank AAI_PUBLIC_ORIGIN is ignored rather than yielding '://host'", () => {
    expect(resolvePublicOrigin(behindTls(), { AAI_PUBLIC_ORIGIN: "  " })).toBe(
      "https://agent.example.modal.run",
    );
  });
});

describe("publicForwardedHeaders", () => {
  test("forwards what the client saw, not the cleartext hop received", () => {
    expect(publicForwardedHeaders(behindTls("/studio/projects"), {})).toEqual({
      host: "agent.example.modal.run",
      proto: "https",
    });
  });

  test("loopback proxying keeps http", () => {
    expect(publicForwardedHeaders(new Request("http://localhost:8080/studio/x"), {})).toEqual({
      host: "localhost:8080",
      proto: "http",
    });
  });
});
