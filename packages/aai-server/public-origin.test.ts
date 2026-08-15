// Copyright 2026 the AAI authors. MIT license.

import { beforeEach, describe, expect, test } from "vitest";
import {
  agentPublicBaseUrl,
  forgetObservedPublicOrigin,
  publicForwardedHeaders,
  rememberPublicOrigin,
  resolvePublicOrigin,
} from "./public-origin.ts";

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

describe("agentPublicBaseUrl", () => {
  // Module state, so it outlives `restoreMocks` — a spec asserting the
  // unobserved case has to be able to get back to it.
  beforeEach(() => {
    forgetObservedPublicOrigin();
  });

  test("resolves nothing before this replica has served a request", () => {
    // The honest answer, and what makes the SDK throw naming the option instead
    // of minting a localhost URL a third party will try days later.
    expect(agentPublicBaseUrl("digest-desk", {})).toBeUndefined();
  });

  test("AAI_PUBLIC_ORIGIN plus the slug, trailing slash stripped", () => {
    expect(agentPublicBaseUrl("digest-desk", { AAI_PUBLIC_ORIGIN: "https://aai.example/" })).toBe(
      "https://aai.example/digest-desk",
    );
  });

  test("falls back to the origin a request was last served on", () => {
    // The path that makes this work with no new configuration: three of the four
    // spawn paths hold no request (blue-green handover, the wake sweep, the peer
    // route), so the value has to outlive the request that established it.
    rememberPublicOrigin(behindTls("/digest-desk/client-config"), {});
    expect(agentPublicBaseUrl("digest-desk", {})).toBe(
      "https://agent.example.modal.run/digest-desk",
    );
  });

  test("configuration wins over what was observed", () => {
    // A deployment reachable on more than one origin is why the operator lever
    // exists: whichever request happened to spawn the guest must not decide.
    rememberPublicOrigin(behindTls(), {});
    expect(agentPublicBaseUrl("x", { AAI_PUBLIC_ORIGIN: "https://aai.example" })).toBe(
      "https://aai.example/x",
    );
  });

  test("a blank AAI_PUBLIC_ORIGIN falls through rather than yielding '/slug'", () => {
    rememberPublicOrigin(behindTls(), {});
    expect(agentPublicBaseUrl("x", { AAI_PUBLIC_ORIGIN: "   " })).toBe(
      "https://agent.example.modal.run/x",
    );
  });
});
