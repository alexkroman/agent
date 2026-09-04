// Copyright 2026 the AAI authors. MIT license.

import { beforeEach, describe, expect, test } from "vitest";
import {
  agentPlatformBaseUrl,
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

/**
 * A local run's own request: loopback Host, which is what
 * `pnpm dev:aai-server` produces and the only shape an origin is LEARNED from.
 */
function onLoopback(path = "/deploy", headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:8080${path}`, { headers });
}

/**
 * A DECLARED local run — the only env in which an observed origin is retained.
 *
 * Spelled out rather than `{}`, which is what these tests used to pass: the
 * sentinel is `AAI_LOCAL_DEV=1` now, so an empty env is production and the
 * retention this file is about does not happen at all.
 */
const LOCAL: NodeJS.ProcessEnv = { AAI_LOCAL_DEV: "1" };

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

  test("the microVM host alias stays http — it is this dev server, in cleartext", () => {
    // Not loopback, so it fell to the `https` branch: a guest resolving its own
    // request produced `https://host.microsandbox.internal:8080`, and every URL
    // derived from that failed the handshake against a plaintext port. Measured
    // in a guest as `uploadBroker: "https://host.microsandbox.internal:8080/…"`.
    expect(resolvePublicOrigin(new Request("http://host.microsandbox.internal:8080/x"), {})).toBe(
      "http://host.microsandbox.internal:8080",
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

describe("agentPlatformBaseUrl — the DIAL base, which is a different claim", () => {
  beforeEach(() => {
    forgetObservedPublicOrigin();
  });

  test("in LOCAL DEV it is derived from this server's OWN port, with nothing configured", () => {
    // The regression. `agentPublicBaseUrl` is undefined here (no config, no
    // observed request), so a guest used to boot with no platform base at all
    // and fall silently onto the DevKit's LOCAL world; and once a request HAD
    // been observed it got a value whose correctness depended on which request
    // that was. Neither is a dial base. This server knows its own port, so it
    // can simply say — which is what makes a studio preview work unconfigured.
    expect(agentPublicBaseUrl("digest-desk", LOCAL)).toBeUndefined();
    expect(agentPlatformBaseUrl("digest-desk", LOCAL)).toBe("http://127.0.0.1:8080/digest-desk");
  });

  test("it honours PORT, because the dial base has to name the port we BOUND", () => {
    expect(agentPlatformBaseUrl("x", { ...LOCAL, PORT: "3000" })).toBe("http://127.0.0.1:3000/x");
  });

  test("it does NOT depend on an observed origin, forged or honest", () => {
    // The whole reason to derive rather than observe: `rememberPublicOrigin` is
    // fed by a caller-supplied Host on every request before any auth, and a
    // guest is a caller too — the in-guest `aai deploy` POSTs back with
    // `Host: host.microsandbox.internal:8080`, an alias resolvable only inside
    // a microVM. Deriving takes this value out of that path entirely.
    rememberPublicOrigin(onLoopback("/x/client-config"), LOCAL);
    expect(agentPlatformBaseUrl("x", LOCAL)).toBe("http://127.0.0.1:8080/x");
  });

  test("configuration still wins, so a tunnel is not overridden by a guess", () => {
    expect(agentPlatformBaseUrl("x", { ...LOCAL, AAI_PUBLIC_ORIGIN: "https://aai.example" })).toBe(
      "https://aai.example/x",
    );
  });

  test("outside local dev it IS the public base — a Modal guest dials the internet", () => {
    // Nothing to derive there: the guest reaches the platform on the very
    // origin a third party uses, so the two claims coincide and
    // `AAI_PUBLIC_ORIGIN` stays the one source.
    const prod = { AAI_PUBLIC_ORIGIN: "https://aai.example" };
    expect(agentPlatformBaseUrl("x", prod)).toBe(agentPublicBaseUrl("x", prod));
    expect(agentPlatformBaseUrl("x", {})).toBeUndefined();
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

  test("in LOCAL DEV, falls back to the origin a request was last served on", () => {
    // Three of the four spawn paths hold no request (blue-green handover, the
    // wake sweep, the peer route), so the value has to outlive the request that
    // established it — which is only acceptable for a request whose Host names
    // this server.
    rememberPublicOrigin(onLoopback("/digest-desk/client-config"), LOCAL);
    expect(agentPublicBaseUrl("digest-desk", LOCAL)).toBe("http://localhost:8080/digest-desk");
  });

  test("configuration wins over what was observed", () => {
    // A deployment reachable on more than one origin is why the operator lever
    // exists: whichever request happened to spawn the guest must not decide.
    rememberPublicOrigin(onLoopback(), LOCAL);
    expect(agentPublicBaseUrl("x", { ...LOCAL, AAI_PUBLIC_ORIGIN: "https://aai.example" })).toBe(
      "https://aai.example/x",
    );
  });

  test("a blank AAI_PUBLIC_ORIGIN falls through rather than yielding '/slug'", () => {
    rememberPublicOrigin(onLoopback(), LOCAL);
    expect(agentPublicBaseUrl("x", { ...LOCAL, AAI_PUBLIC_ORIGIN: "   " })).toBe(
      "http://localhost:8080/x",
    );
  });

  describe("even in LOCAL DEV, only a host that NAMES this server is learned from", () => {
    test("a forged Host cannot redirect the next spawn", () => {
      // Reproduced against a real dev server before the fix: one
      // `curl -H 'Host: evil.example' localhost:8080/health` and the very next
      // Publish answered `deploy failed: could not reach
      // https://evil.example/deploy`. Same injection as the production case
      // below, in the environment that was excused from it.
      // The forged Host is spelled as the request URL's own host, which is how
      // the app sees it: Hono builds `req.url` from that header, and undici
      // refuses to set `host` as a literal header on a `Request`.
      rememberPublicOrigin(onLoopback(), LOCAL);
      rememberPublicOrigin(new Request("http://evil.example/health"), LOCAL);
      expect(agentPublicBaseUrl("victim", LOCAL)).toBe("http://localhost:8080/victim");
    });

    test("a GUEST's own request cannot either", () => {
      // The microVM backend's in-guest `aai deploy` POSTs back with `Host:
      // host.microsandbox.internal:8080` — tenant code, on every Publish. What
      // it wrote was baked into the next spawn of ANY slug as
      // `AAI_PUBLIC_BASE_URL`, i.e. the origin `publicWebhookUrl` mints third-
      // party callbacks from, and that name resolves only inside a microVM.
      rememberPublicOrigin(onLoopback(), LOCAL);
      rememberPublicOrigin(new Request("http://host.microsandbox.internal:8080/deploy"), LOCAL);
      expect(agentPublicBaseUrl("victim", LOCAL)).toBe("http://localhost:8080/victim");
    });

    test("an x-forwarded-host is refused the same way", () => {
      // The resolved origin is what is checked, not the raw `Host` — otherwise
      // the same injection walks in through the header a proxy would set.
      rememberPublicOrigin(onLoopback(), LOCAL);
      rememberPublicOrigin(onLoopback("/health", { "x-forwarded-host": "evil.example" }), LOCAL);
      expect(agentPublicBaseUrl("victim", LOCAL)).toBe("http://localhost:8080/victim");
    });

    test("but it still RETURNS the resolved origin to the request that asked", () => {
      // Refusing to LEARN is not refusing to answer: a use inside the request
      // is self-directed, and a caller who lies gets its own lie back.
      expect(rememberPublicOrigin(new Request("http://evil.example/x"), LOCAL)).toBe(
        "https://evil.example",
      );
    });
  });

  describe("in production, no request teaches this replica an origin", () => {
    // Production is anything that has not DECLARED itself a local run — an
    // empty environment included, which is the property that matters: the
    // retention below must be something someone asked for, never what a
    // forgotten variable leaves on (see `isLocalDev` in _boot.ts).
    const PROD: NodeJS.ProcessEnv = {};

    test("an attacker's Host header cannot poison another tenant's guest", () => {
      // The attack, end to end. `rememberPublicOrigin` runs from the shared
      // middleware on EVERY request before any auth, and what it records is
      // baked into the NEXT sandbox this replica spawns — any slug, any tenant
      // — as AAI_PUBLIC_BASE_URL, which is what `publicWebhookUrl(token)` mints
      // and what a workflow author hands to a payment provider. One
      // unauthenticated `GET /health` used to be the whole exploit.
      rememberPublicOrigin(new Request("http://evil.example/health"), PROD);
      expect(agentPublicBaseUrl("someone-elses-agent", PROD)).toBeUndefined();

      // Not even via the forwarded headers, which are equally caller-supplied
      // when nothing proxies this service.
      rememberPublicOrigin(
        behindTls("/health", { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" }),
        PROD,
      );
      expect(agentPublicBaseUrl("someone-elses-agent", PROD)).toBeUndefined();
    });

    test("a legitimate request is not learned from either — only config is", () => {
      // There is no header that distinguishes an honest Host from a forged one,
      // so the answer is not a better check: it is refusing to guess. The SDK's
      // throw naming `publicUrl` is the report, and `AAI_PUBLIC_ORIGIN` the fix.
      rememberPublicOrigin(behindTls("/digest-desk/client-config"), PROD);
      expect(agentPublicBaseUrl("digest-desk", PROD)).toBeUndefined();
      expect(
        agentPublicBaseUrl("digest-desk", { ...PROD, AAI_PUBLIC_ORIGIN: "https://aai.example" }),
      ).toBe("https://aai.example/digest-desk");
    });

    test("still RETURNS the resolved origin for the request that asked", () => {
      // The self-directed uses (a redirect Location, the URL a carrier signed)
      // are unaffected — only the cross-request memory is refused.
      expect(rememberPublicOrigin(behindTls("/health"), PROD)).toBe(
        "https://agent.example.modal.run",
      );
    });
  });
});
