// Copyright 2026 the AAI authors. MIT license.
/**
 * The loopback rewrite and the policy it derives.
 *
 * Both halves are the difference between a working dev guest and a broken one:
 * an unrewritten `127.0.0.1` in the guest env points at the VM, and a port the
 * policy did not open is refused even after the rewrite. The negative cases
 * matter as much as the positive — a policy that opened the whole `host` group
 * would pass every "can it reach the database" test and hand tenant code the
 * developer's entire machine.
 */

import { describe, expect, test } from "vitest";
import {
  assertGuestCanReachItsEnv,
  callerReachableUrl,
  GUEST_EGRESS_DEFAULT,
  GUEST_INGRESS_DEFAULT,
  guestEgressRules,
  HOST_ALIAS,
  rewriteLoopbackForGuest,
  runtimeMintedHostPorts,
} from "./microsandbox-network.ts";

describe("rewriteLoopbackForGuest", () => {
  test("rewrites a Postgres DSN and reports its port", () => {
    const { env, hostPorts } = rewriteLoopbackForGuest({
      DATABASE_URL: "postgresql://app:pw@127.0.0.1:54322/app_db",
    });
    expect(env.DATABASE_URL).toBe(`postgresql://app:pw@${HOST_ALIAS}:54322/app_db`);
    expect(hostPorts).toEqual([54_322]);
  });

  test.each([
    ["127.0.0.1", "http://127.0.0.1:54321/storage", 54_321],
    ["localhost", "http://localhost:54321/storage", 54_321],
    ["[::1]", "http://[::1]:54321/storage", 54_321],
  ])("rewrites the %s spelling", (_name, value, port) => {
    // `[::1]` is the one that regressed: a `\b` anchor cannot match before `[`,
    // so an anchored pattern silently skipped every IPv6 loopback.
    const { env, hostPorts } = rewriteLoopbackForGuest({ URL: value });
    expect(env.URL).toContain(HOST_ALIAS);
    expect(env.URL).not.toMatch(/127\.0\.0\.1|localhost|\[::1\]/);
    expect(hostPorts).toEqual([port]);
  });

  test("derives a port from the SCHEME when the URL omits one", () => {
    // The guest still opens a connection to port 80; a policy that omitted it
    // would refuse the request the rewrite just made possible.
    const { env, hostPorts } = rewriteLoopbackForGuest({
      A: "http://localhost/health",
      B: "https://localhost/secure",
    });
    expect(env.A).toBe(`http://${HOST_ALIAS}/health`);
    expect(hostPorts).toEqual([80, 443]);
  });

  test("resolves each mention's own scheme, not the first one's", () => {
    // The replace callback's offset is what makes this right; `indexOf(match)`
    // resolved every mention against the FIRST occurrence.
    const { hostPorts } = rewriteLoopbackForGuest({
      PAIR: "http://localhost/a and https://localhost/b",
    });
    expect(hostPorts).toEqual([80, 443]);
  });

  test("leaves a non-loopback host alone", () => {
    const { env, hostPorts } = rewriteLoopbackForGuest({
      REMOTE: "postgresql://app@db.example.com:5432/x",
      LOOKALIKE: "https://mylocalhost.dev/api",
    });
    expect(env.REMOTE).toBe("postgresql://app@db.example.com:5432/x");
    // `mylocalhost` is not loopback; a `\b` anchor would have rewritten it.
    expect(env.LOOKALIKE).toBe("https://mylocalhost.dev/api");
    expect(hostPorts).toEqual([]);
  });

  test("dedupes and sorts the ports", () => {
    const { hostPorts } = rewriteLoopbackForGuest({
      A: "http://127.0.0.1:54322/x",
      B: "postgresql://localhost:54322/y",
      C: "http://localhost:54321/z",
    });
    expect(hostPorts).toEqual([54_321, 54_322]);
  });

  test("rewrites a bare loopback mention but opens no port for it", () => {
    // Nothing says which port it needs, and guessing would widen the policy on
    // the strength of a guess.
    const { env, hostPorts } = rewriteLoopbackForGuest({ HOST: "127.0.0.1" });
    expect(env.HOST).toBe(HOST_ALIAS);
    expect(hostPorts).toEqual([]);
  });
});

describe("guestEgressRules", () => {
  test("re-declares DNS, because a custom policy REPLACES the defaults", () => {
    // Measured: a policy that only added a host rule dropped the built-in DNS
    // rule, and every hostname inside the guest failed with ENOTFOUND.
    const dns = guestEgressRules([]).find((r) => r.ports.includes(53));
    expect(dns).toBeDefined();
    expect(dns?.group).toBe("host");
    // UDP as well as TCP — a resolver tries UDP first.
    expect(dns?.protocols).toEqual(expect.arrayContaining(["tcp", "udp"]));
  });

  test("allows public egress, so provider APIs and the npm registry work", () => {
    const publicRule = guestEgressRules([]).find((r) => r.group === "public");
    expect(publicRule).toBeDefined();
    // No ports: the whole public internet, which is what a workspace build and
    // a provider SDK both need.
    expect(publicRule?.ports).toEqual([]);
  });

  test("opens the derived host ports and NOTHING else on the host", () => {
    const rules = guestEgressRules([54_321, 54_322]);
    const hostPorts = rules
      .filter((r) => r.group === "host")
      .flatMap((r) => [...r.ports])
      .sort((a, b) => a - b);
    expect(hostPorts).toEqual([53, 54_321, 54_322]);
  });

  test("every host rule carries ports — a port-less one would open the host", () => {
    // The failure this prevents passes every "can it reach the database" test
    // while handing tenant code the whole developer machine.
    for (const rule of guestEgressRules([54_322]).filter((r) => r.group === "host")) {
      expect(rule.ports.length).toBeGreaterThan(0);
    }
  });

  test("adds no host rule beyond DNS when nothing was rewritten", () => {
    expect(guestEgressRules([]).filter((r) => r.group === "host")).toHaveLength(1);
  });

  test("names no destination group other than host and public", () => {
    // `local`/`loopback` would be the easy widening; neither is wanted.
    const groups = new Set(guestEgressRules([54_322]).map((r) => r.group));
    expect([...groups].sort()).toEqual(["host", "public"]);
  });

  test("egress defaults to DENY so an unlisted destination is refused", () => {
    expect(GUEST_EGRESS_DEFAULT).toBe("deny");
    expect(GUEST_INGRESS_DEFAULT).toBe("allow");
  });
});

describe("assertGuestCanReachItsEnv — the exhaustive half of the rewrite rule", () => {
  // The five historical instances of one bug, as data. Each is a URL that crossed
  // the platform->guest boundary without being rewritten, each failed silently,
  // and each was found in production or in a developer's dev server rather than by
  // a test. `guestReachableUrl` asks call sites to remember; this asserts the
  // property, so a key added tomorrow is covered without anybody remembering.
  test.each([
    ["the agent env's DSNs", { DATABASE_URL: "postgresql://app@127.0.0.1:54322/app" }],
    ["the worker bundle URL", { AAI_BUNDLE_URL: "http://127.0.0.1:54321/blobs/w.mjs" }],
    ["the in-guest deploy origin", { AAI_STUDIO_SERVER: "http://localhost:8080" }],
    ["the platform dial base", { AAI_PLATFORM_BASE_URL: "http://127.0.0.1:8080/demo" }],
    ["a signed upload read URL", { AAI_SOME_SIGNED_URL: "http://[::1]:54321/object/sign/x" }],
  ])("refuses %s", (_label, env) => {
    expect(() => assertGuestCanReachItsEnv(env, [8080, 54_321, 54_322])).toThrow(
      /inside a microVM is the GUEST/,
    );
  });

  test("names the KEY, because the failure otherwise names only a fetch", () => {
    // The whole cost of these bugs was diagnosis: `TypeError: fetch failed` four
    // retries deep says nothing about which value was wrong.
    expect(() =>
      assertGuestCanReachItsEnv({ DATABASE_URL: "postgres://x@localhost:5432/y" }, [5432]),
    ).toThrow(/DATABASE_URL/);
  });

  test("accepts a fully rewritten env", () => {
    expect(() =>
      assertGuestCanReachItsEnv(
        {
          DATABASE_URL: `postgresql://app@${HOST_ALIAS}:54322/app`,
          AAI_PLATFORM_BASE_URL: `http://${HOST_ALIAS}:8080/demo`,
          AAI_GUEST_TOKEN: "not-a-url",
        },
        [8080, 54_322],
      ),
    ).not.toThrow();
  });

  test("refuses the alias on a port the policy never OPENED", () => {
    // The second half, and not optional: a URL correctly rewritten to the alias on
    // a closed port fails in precisely the same way as one left on loopback — a
    // bare `fetch failed` — so a reviewer looking only at the URL cannot tell them
    // apart. This is the arm that catches a runtime-minted URL's port.
    expect(() =>
      assertGuestCanReachItsEnv({ AAI_UPLOAD_BROKER_URL: `http://${HOST_ALIAS}:54321/x` }, [8080]),
    ).toThrow(/does not\s+open/);
  });

  test("AAI_PUBLIC_BASE_URL is the ONE exemption, and it is declared", () => {
    // It is what a third party is handed, so the alias would be unreachable for
    // exactly the caller it exists for. The exemption is per KEY and written down;
    // anything else with a loopback host fails, which is what makes a new URL key
    // default into being checked.
    expect(() =>
      assertGuestCanReachItsEnv({ AAI_PUBLIC_BASE_URL: "http://127.0.0.1:8080/demo" }, []),
    ).not.toThrow();
  });
});

describe("callerReachableUrl", () => {
  test("rewrites for a caller that reached us on the microVM alias", () => {
    expect(callerReachableUrl("http://127.0.0.1:54321/object/sign/x", `${HOST_ALIAS}:8080`)).toBe(
      `http://${HOST_ALIAS}:54321/object/sign/x`,
    );
  });

  test.each([
    ["a browser on loopback", "localhost:8080"],
    ["a public host", "aai.example.com"],
    ["no Host at all", undefined],
  ])("leaves it alone for %s", (_label, host) => {
    // The alias resolves nowhere outside a microVM, so rewriting for these would
    // break the caller the plain URL is correct for. These routes serve browsers.
    const url = "http://127.0.0.1:54321/object/sign/x";
    expect(callerReachableUrl(url, host)).toBe(url);
  });
});

describe("runtimeMintedHostPorts", () => {
  test("opens the port a signed upload read lands on", () => {
    // Not derivable from any value the guest holds: the platform mints the URL per
    // read, on its own Supabase origin, and 302s the guest to it.
    expect(runtimeMintedHostPorts({ SUPABASE_URL: "http://127.0.0.1:54321" })).toEqual([54_321]);
  });

  test.each([
    ["a real project, which needs no host rule", { SUPABASE_URL: "https://abc.supabase.co" }],
    ["no storage at all", {}],
    ["an unparseable origin", { SUPABASE_URL: "not a url" }],
  ])("opens nothing for %s", (_label, env) => {
    expect(runtimeMintedHostPorts(env)).toEqual([]);
  });
});
