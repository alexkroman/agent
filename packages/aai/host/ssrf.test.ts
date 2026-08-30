// Copyright 2025 the AAI authors. MIT license.
/**
 * SSRF protection tests.
 *
 * Covers:
 * - Decimal/octal/hex IP encoding
 * - DNS rebinding patterns
 * - Protocol smuggling
 * - Redirect chain limits
 * - IPv6 shorthand notation
 * - Cloud metadata endpoints
 * - Comprehensive private IP range detection
 */

import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import { fakeFetch } from "./_test-utils.ts";
import {
  builtinFetch,
  CONTAINED_ENV,
  isPrivateIp,
  pinnedFetch,
  pinnedLookup,
  resolveAndAssertPublic,
  safeFetch,
  ssrfSafeFetch,
} from "./ssrf.ts";

// ── IP Encoding Bypass Attempts ────────────────────────────────────────

describe("SSRF: IP encoding bypass attempts", () => {
  // This spec used to wrap the call in a try/catch that asserted only in the
  // catch, above a comment explaining that the outcome "may or may not"
  // depend on the URL parser — so a regression letting decimal-encoded
  // localhost through as PUBLIC kept it green. In the SSRF suite, of all
  // places. And the premise was simply false: the comment claimed
  // "URL.hostname keeps the numeric form", but the WHATWG parser normalizes
  // `2130706433` to `127.0.0.1` before this module ever sees it, so the
  // behaviour is deterministic AND stronger than claimed — rejected as a
  // literal private address, with DNS never consulted, so no resolver answer
  // could let it through.
  test("blocks decimal-encoded localhost outright (2130706433 = 127.0.0.1)", async () => {
    expect(new URL("http://2130706433/").hostname).toBe("127.0.0.1");

    const lookup = vi.fn(async () => ({ address: "93.184.216.34" }));
    await expect(resolveAndAssertPublic("http://2130706433/", lookup)).rejects.toThrow(
      "Blocked request to private address: 127.0.0.1",
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  test("blocks IPv6 compact notation for loopback", async () => {
    await expect(resolveAndAssertPublic("http://[::1]/")).rejects.toThrow("Blocked");
    await expect(resolveAndAssertPublic("http://[0:0:0:0:0:0:0:1]/")).rejects.toThrow("Blocked");
  });

  test("blocks IPv6 compact notation for unspecified address", async () => {
    await expect(resolveAndAssertPublic("http://[::]/")).rejects.toThrow("Blocked");
  });

  test("blocks IPv4-mapped IPv6 for various private ranges", async () => {
    // 172.16.x.x range
    await expect(resolveAndAssertPublic("http://[::ffff:172.16.0.1]/")).rejects.toThrow("Blocked");

    // 10.x.x.x range
    await expect(resolveAndAssertPublic("http://[::ffff:10.0.0.1]/")).rejects.toThrow("Blocked");

    // 192.168.x.x range
    await expect(resolveAndAssertPublic("http://[::ffff:192.168.0.1]/")).rejects.toThrow("Blocked");

    // Link-local (169.254.x.x)
    await expect(resolveAndAssertPublic("http://[::ffff:169.254.169.254]/")).rejects.toThrow(
      "Blocked",
    );
  });

  test.each([
    ["64:ff9b::7f00:1", "127.0.0.1 via the NAT64 well-known prefix"],
    ["64:ff9b::a9fe:a9fe", "169.254.169.254 via NAT64 — the cloud metadata endpoint"],
    ["64:ff9b::a00:1", "10.0.0.1 via NAT64"],
    ["64:ff9b::c0a8:1", "192.168.0.1 via NAT64"],
    ["2002:7f00:1::", "127.0.0.1 via the 6to4 prefix"],
    ["2002:a9fe:a9fe::", "169.254.169.254 via 6to4"],
    ["2002:a00:1::", "10.0.0.1 via 6to4"],
  ])("blocks %s — %s", async (address) => {
    // The TRANSLATION prefixes, which name an IPv4 destination the same way
    // `::ffff:` does and which `bogon` does not flag. On a host with a NAT64
    // gateway or a 6to4 relay — an IPv6-only network, which is what NAT64
    // exists for — these reach the IPv4 address they carry. The suite already
    // defends the mapped and compatible forms above; these were the gap.
    await expect(resolveAndAssertPublic(`http://[${address}]/`)).rejects.toThrow("Blocked");
  });

  test.each([
    ["64:ff9b::808:808", "8.8.8.8 via NAT64"],
    ["2002:808:808::", "8.8.8.8 via 6to4"],
  ])("still ALLOWS %s — %s", async (address) => {
    // The half that must not regress: on an IPv6-only network EVERY IPv4
    // destination is reached through `64:ff9b::`, so refusing the prefix
    // outright would refuse the whole IPv4 internet there. The embedded
    // address is what gets screened, not the wrapper.
    await expect(resolveAndAssertPublic(`http://[${address}]/`)).resolves.toBeNull();
  });

  test("blocks link-local IPv4 range", async () => {
    await expect(resolveAndAssertPublic("http://169.254.1.1/")).rejects.toThrow(
      "Blocked request to private address",
    );
  });

  test.each([
    ["fc00::1"],
    ["fd00::1"],
    ["fd12:3456::1"],
    ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ])("blocks IPv6 unique-local addresses (fc00::/7): isPrivateIp(%s)", (ip: string) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  test("blocks IPv6 link-local addresses (fe80::/10)", () => {
    expect(isPrivateIp("fe80::1")).toBe(true);
    // fe80::1%eth0 with zone ID stripped is also fe80::1
    expect(isPrivateIp("fe80::1%eth0".split("%")[0] as string)).toBe(true);
  });

  test.each([
    ["ff00::1"],
    ["ff02::1"], // link-local all nodes
  ])("blocks IPv6 multicast addresses (ff00::/8): isPrivateIp(%s)", (ip: string) => {
    expect(isPrivateIp(ip)).toBe(true);
  });
});

// ── Hostname / IP Bypass Attempts ─────────────────────────────────────

describe("SSRF: hostname bypass attempts", () => {
  test("blocks cloud metadata endpoints", async () => {
    // AWS metadata
    await expect(
      resolveAndAssertPublic("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow("Blocked");
    // AWS metadata via IP
    await expect(resolveAndAssertPublic("http://169.254.169.254/latest/api/token")).rejects.toThrow(
      "Blocked",
    );
  });
});

// ── Protocol Validation ────────────────────────────────────────────────

describe("SSRF: protocol validation", () => {
  test("blocks file:// protocol", async () => {
    await expect(resolveAndAssertPublic("file:///etc/passwd")).rejects.toThrow(
      "disallowed protocol",
    );
  });

  test("blocks ftp:// protocol", async () => {
    await expect(resolveAndAssertPublic("ftp://example.com/")).rejects.toThrow(
      "disallowed protocol",
    );
  });

  test("blocks gopher:// protocol", async () => {
    await expect(resolveAndAssertPublic("gopher://example.com/")).rejects.toThrow();
  });

  test("blocks data: protocol", async () => {
    await expect(resolveAndAssertPublic("data:text/html,<h1>test</h1>")).rejects.toThrow();
  });

  // ── The allow half, on the INJECTED resolver rather than on real DNS ──
  //
  // These three used to open `try { await requireDns() } catch { return }` and
  // then hit the network. In a leg without DNS all three RETURNED before their
  // single assertion and reported green — a silent skip nothing announced and
  // no `AAI_REQUIRE_*` covered — and where DNS did work the assertion was
  // `resolves.toEqual(expect.any(String))`, which `""` satisfies. The helper
  // itself was also a hand-rolled `Promise.race` against a `setTimeout`, the
  // shape `guard-invariants` rule 3 bans (and, spanning three lines, could not
  // see).
  //
  // `lookupFn` is the seam this module already publishes for exactly this: the
  // protocol check, the hostname rules and the private-address screen all still
  // run, and the RESOLVED ADDRESS — the value the caller pins the socket to —
  // is asserted by identity instead of by "is a string".
  test.each([
    ["http://example.com/", "93.184.216.34"],
    ["https://example.com/", "93.184.216.34"],
    ["https://api.brave.com/search", "23.55.190.15"],
  ])("allows %s and returns the address to pin", async (url, address) => {
    const lookup = vi.fn(async () => ({ address }));
    await expect(resolveAndAssertPublic(url, lookup)).resolves.toBe(address);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

// ── DNS Failure Handling ───────────────────────────────────────────────

// ── DNS Rebinding ──────────────────────────────────────────────────────
//
// The defense this module's header lists first, and until the resolver became
// injectable it had NO deterministic test: the branch is only reachable by
// controlling what a hostname resolves to, which meant a `node:dns/promises`
// module mock — parked in its own file (`ssrf-pinning.test.ts`) precisely so
// it would not leak into this suite, where it tests resolution COUNT rather
// than the private-address rejection.

describe("SSRF: DNS rebinding", () => {
  test("a public-looking hostname resolving to a private address is blocked", async () => {
    await expect(
      resolveAndAssertPublic("http://rebind.example.com/", async () => ({
        address: "169.254.169.254",
      })),
    ).rejects.toThrow("rebind.example.com resolves to private address 169.254.169.254");
  });

  test.each(["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "::1", "::ffff:127.0.0.1"])(
    "a hostname resolving to %s is blocked",
    async (address) => {
      await expect(
        resolveAndAssertPublic("http://attacker.example.com/", async () => ({ address })),
      ).rejects.toThrow("Blocked");
    },
  );

  test("a hostname resolving to a public address returns that address for pinning", async () => {
    // The pin is what closes the TOCTOU window — the caller dials the address
    // this returned, not the name, so a second resolution cannot redirect it.
    await expect(
      resolveAndAssertPublic("http://ok.example.com/", async () => ({ address: "93.184.216.34" })),
    ).resolves.toBe("93.184.216.34");
  });

  test("a hostname is resolved exactly once", async () => {
    const lookup = vi.fn(async () => ({ address: "93.184.216.34" }));
    await resolveAndAssertPublic("http://ok.example.com/", lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("ok.example.com");
  });

  test("a literal IP is never resolved at all", async () => {
    const lookup = vi.fn(async () => ({ address: "127.0.0.1" }));
    // Returns null (nothing to pin) and must not consult DNS — a lookup here
    // would be a second chance for the answer to change.
    await expect(resolveAndAssertPublic("http://93.184.216.34/", lookup)).resolves.toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("SSRF: DNS failure handling", () => {
  test("a resolver that hangs past the deadline is blocked, not awaited", async () => {
    await expect(
      resolveAndAssertPublic("http://slow.example.com/", () => new Promise(() => undefined)),
    ).rejects.toThrow("DNS resolution failed");
  }, 10_000);

  test("a DNS failure is reported with its cause attached", async () => {
    // Killed mutant: `{ cause: err }` -> `{}`. The cause is the only thing
    // that says WHY resolution failed — without it the operator sees
    // "Blocked request: DNS resolution failed" and nothing else.
    const boom = new Error("EAI_AGAIN");
    await expect(
      resolveAndAssertPublic("http://nope.example.com/", () => Promise.reject(boom)),
    ).rejects.toMatchObject({ cause: boom });
  });

  test("resolveAndAssertPublic rejects when DNS resolution fails", async () => {
    // Use a subdomain of example.com (IANA reserved, no DNS) that bogon doesn't classify as private
    await expect(resolveAndAssertPublic("http://nxdomain-test.example.com/")).rejects.toThrow(
      /Blocked request.*DNS/,
    );
  }, 10_000);
});

// ── Mutation-test findings ─────────────────────────────────────────────
//
// `ssrf.ts` scored 70.91% under Stryker with 27 survivors. The ones below are
// the security-relevant ones: each mutant changes what the screen DOES, and
// the suite could not tell.

describe("SSRF: request-input normalization", () => {
  // `requestUrl` handles the three shapes `fetch` accepts. Only the string
  // branch had a test — the `URL` branch had NO COVERAGE and the `Request`
  // branch none either, while mutants flipping the string check survived. The
  // URL a caller passes is the URL that gets SCREENED, so a mishandled shape
  // screens the wrong thing (or `[object Object]`) and the block is bypassed.
  test.each([
    ["string", "http://127.0.0.1/admin"],
    ["URL", new URL("http://127.0.0.1/admin")],
    ["Request", new Request("http://127.0.0.1/admin")],
  ])("safeFetch screens a %s input", async (_label, input) => {
    await expect(safeFetch(input as Parameters<typeof safeFetch>[0])).rejects.toThrow("Blocked");
  });

  test("safeFetch forwards its init rather than replacing it", async () => {
    // Killed mutant: `init ?? {}` -> `init && {}`, which DROPS a supplied
    // init entirely — method, body and headers all silently lost.
    const seen: RequestInit[] = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response("ok");
    });
    await ssrfSafeFetch(
      "https://93.184.216.34/",
      { method: "POST", headers: { "x-probe": "1" } },
      fakeFetch(fetchFn),
    );
    expect(seen[0]?.method).toBe("POST");
    expect(new Headers(seen[0]?.headers).get("x-probe")).toBe("1");
  });

  test("every hop is issued with redirect: manual", async () => {
    // Killed mutant: `redirect: "manual"` -> `redirect: ""`. Letting fetch
    // follow redirects itself is the whole bypass — the hops never come back
    // here, so none of them is re-validated and a 302 to 127.0.0.1 is fetched
    // by undici without ever being screened.
    const modes: (RequestInit["redirect"] | undefined)[] = [];
    let hop = 0;
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      modes.push(init.redirect);
      hop++;
      return hop === 1
        ? new Response("", { status: 302, headers: { Location: "https://93.184.216.34/next" } })
        : new Response("done");
    });
    await ssrfSafeFetch("https://93.184.216.34/", {}, fakeFetch(fetchFn));
    expect(modes).toEqual(["manual", "manual"]);
  });
});

describe("SSRF: reserved hostnames", () => {
  // The rule that is actually doing the work: BOTH named metadata hosts end
  // in `.internal`, so the TLD list catches them and emptying BLOCKED_HOSTS
  // changes nothing. Pin the TLD rule, which is the one a regression would
  // really remove.
  test.each([
    "metadata.google.internal",
    "instance-data.ec2.internal",
    "anything.internal",
    "printer.local",
    "foo.localhost",
  ])("%s is refused without any DNS lookup", async (host) => {
    const lookup = vi.fn(async () => ({ address: "93.184.216.34" }));
    await expect(resolveAndAssertPublic(`http://${host}/`, lookup)).rejects.toThrow(
      "reserved hostname",
    );
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("SSRF: DNS pin", () => {
  // `pinnedDispatcher` is only reachable through a DNS-resolved hostname, so
  // its whole body survived mutation — address, family, and the callback
  // itself — while `ssrf-dispatcher.test.ts` exercised an Agent it built
  // itself rather than the one this module builds. The pin is the TOCTOU /
  // rebinding defense: the socket must be able to reach only the address
  // already screened, whatever DNS says a moment later.
  const resolve = (ip: string) =>
    new Promise<{ address: string; family: number }[]>((done) => {
      pinnedLookup(ip)("anything.example.com", {}, (_err, addresses) => done(addresses));
    });

  test("answers with the screened address, ignoring the hostname", async () => {
    await expect(resolve("93.184.216.34")).resolves.toEqual([
      { address: "93.184.216.34", family: 4 },
    ]);
  });

  test.each([
    ["93.184.216.34", 4],
    ["8.8.8.8", 4],
    ["2606:2800:220:1:248:1893:25c8:1946", 6],
    ["::ffff:93.184.216.34", 6],
  ])("%s is announced as family %i", async (ip, family) => {
    // undici refuses a v4 address announced as family 6 and vice versa, and
    // the refusal surfaces as an opaque fetch failure naming nothing.
    await expect(resolve(ip)).resolves.toEqual([{ address: ip, family }]);
  });
});

// ── Hostname-Based Blocking ────────────────────────────────────────────

describe("hostname-based blocking", () => {
  test.each([
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://instance-data.ec2.internal/latest/meta-data/",
    "http://evil.internal/",
    "http://evil.local/",
    "http://evil.localhost/",
  ])("blocks reserved hostname: %s", async (url: string) => {
    await expect(resolveAndAssertPublic(url)).rejects.toThrow(/Blocked request.*reserved hostname/);
  });
});

// ── Private IP Detection Completeness ──────────────────────────────────

describe("isPrivateIp: comprehensive private range coverage", () => {
  test.each([
    // 10.0.0.0/8
    ["10.0.0.0", true],
    ["10.255.255.255", true],
    ["10.50.100.200", true],
    // 172.16.0.0/12
    ["172.16.0.0", true],
    ["172.31.255.255", true],
    ["172.20.0.1", true],
    ["172.32.0.1", false], // 172.32.x.x is public
    // 192.168.0.0/16
    ["192.168.0.0", true],
    ["192.168.255.255", true],
  ] as const)(
    "blocks all RFC 1918 private ranges: isPrivateIp(%s) === %s",
    (ip: string, expected: boolean) => {
      expect(isPrivateIp(ip)).toBe(expected);
    },
  );

  test.each([
    ["100.64.0.0", true],
    ["100.127.255.255", true],
    ["100.128.0.1", false], // 100.128.x.x is public
  ] as const)(
    "blocks carrier-grade NAT range (100.64.0.0/10): isPrivateIp(%s) === %s",
    (ip: string, expected: boolean) => {
      expect(isPrivateIp(ip)).toBe(expected);
    },
  );

  test.each([
    ["127.0.0.1", true],
    ["127.255.255.255", true],
    ["127.0.0.0", true],
  ] as const)(
    "blocks loopback range (127.0.0.0/8): isPrivateIp(%s) === %s",
    (ip: string, expected: boolean) => {
      expect(isPrivateIp(ip)).toBe(expected);
    },
  );

  test.each([
    ["169.254.0.0", true],
    ["169.254.169.254", true],
    ["169.254.255.255", true],
  ] as const)(
    "blocks link-local range (169.254.0.0/16): isPrivateIp(%s) === %s",
    (ip: string, expected: boolean) => {
      expect(isPrivateIp(ip)).toBe(expected);
    },
  );

  test.each([
    ["198.18.0.0", true],
    ["198.19.255.255", true],
    ["198.20.0.1", false], // 198.20.x.x is public
  ] as const)(
    "blocks benchmarking range (198.18.0.0/15): isPrivateIp(%s) === %s",
    (ip: string, expected: boolean) => {
      expect(isPrivateIp(ip)).toBe(expected);
    },
  );

  test.each([
    ["192.0.0.1", true],
    ["192.0.0.255", true],
    ["192.0.1.1", false], // 192.0.1.x is public
  ] as const)(
    "blocks IANA special-purpose (192.0.0.0/24): isPrivateIp(%s) === %s",
    (ip: string, expected: boolean) => {
      expect(isPrivateIp(ip)).toBe(expected);
    },
  );

  test.each([
    ["224.0.0.1", true], // 224.0.0.0/4 — multicast
    ["239.255.255.255", true],
    ["240.0.0.1", true], // 240.0.0.0/4 — reserved for future use
    ["255.255.255.254", true],
  ] as const)(
    "blocks multicast and reserved ranges: isPrivateIp(%s) === %s",
    (ip: string, expected: boolean) => {
      expect(isPrivateIp(ip)).toBe(expected);
    },
  );

  test.each([
    ["8.8.8.8", false], // Google DNS
    ["1.1.1.1", false], // Cloudflare DNS
    ["208.67.222.222", false], // OpenDNS
    ["93.184.216.34", false], // example.com
    ["151.101.1.140", false], // Reddit
  ] as const)(
    "correctly identifies public IPs: isPrivateIp(%s) === %s",
    (ip: string, expected: boolean) => {
      expect(isPrivateIp(ip)).toBe(expected);
    },
  );
});

// ── Property-based tests ─────────────────────────────────────────────────

describe("property: isPrivateIp", () => {
  /** Generate a valid octet (0-255) */
  const octet = fc.integer({ min: 0, max: 255 });

  test("all RFC 1918 10.x.x.x addresses are private", () => {
    fc.assert(
      fc.property(octet, octet, octet, (b, c, d) => {
        expect(isPrivateIp(`10.${b}.${c}.${d}`)).toBe(true);
      }),
    );
  });

  test("all RFC 1918 172.16-31.x.x addresses are private", () => {
    const secondOctet = fc.integer({ min: 16, max: 31 });
    fc.assert(
      fc.property(secondOctet, octet, octet, (b, c, d) => {
        expect(isPrivateIp(`172.${b}.${c}.${d}`)).toBe(true);
      }),
    );
  });

  test("all RFC 1918 192.168.x.x addresses are private", () => {
    fc.assert(
      fc.property(octet, octet, (c, d) => {
        expect(isPrivateIp(`192.168.${c}.${d}`)).toBe(true);
      }),
    );
  });

  test("all loopback 127.x.x.x addresses are private", () => {
    fc.assert(
      fc.property(octet, octet, octet, (b, c, d) => {
        expect(isPrivateIp(`127.${b}.${c}.${d}`)).toBe(true);
      }),
    );
  });
});

describe("builtinFetch", () => {
  // One rule: screen only when there is no container around us.
  test("screens by default — the self-hosted host is someone's machine", () => {
    expect(builtinFetch({})).toBe(safeFetch);
  });

  test("opens up only when a spawner declares a real container", () => {
    expect(builtinFetch({ [CONTAINED_ENV]: "1" })).toBe(pinnedFetch);
  });

  test("a guest is not automatically contained", () => {
    // The subprocess backend runs a guest as a child process on the dev
    // machine with no container: having a guest token must not open egress.
    expect(builtinFetch({ AAI_GUEST_TOKEN: "tok" })).toBe(safeFetch);
  });

  test.each(["0", "true", "yes", ""])("only an exact 1 opts in, not %j", (v) => {
    expect(builtinFetch({ [CONTAINED_ENV]: v })).toBe(safeFetch);
  });
});
