// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { matchesAllowedHost, validateAllowedHostPattern } from "./allowed-hosts.ts";

function expectInvalid(pattern: string, reasonPattern?: RegExp): void {
  const result = validateAllowedHostPattern(pattern);
  // biome-ignore lint/suspicious/noMisplacedAssertion: shared assertion helper used inside test()
  expect(result.valid).toBe(false);
  if (reasonPattern) {
    // biome-ignore lint/suspicious/noMisplacedAssertion: shared assertion helper used inside test()
    expect((result as { valid: false; reason: string }).reason).toMatch(reasonPattern);
  }
}

describe("validateAllowedHostPattern", () => {
  describe("valid patterns", () => {
    test.each([
      ["api.weather.com"],
      ["example.com"],
      ["*.mycompany.com"],
      ["*.api.mycompany.com"],
    ])("accepts %s", (pattern) => {
      expect(validateAllowedHostPattern(pattern)).toEqual({ valid: true });
    });
  });

  describe("rejects bare wildcards", () => {
    test("rejects bare *", () => {
      expectInvalid("*", /bare/i);
    });

    test("rejects bare **", () => {
      expectInvalid("**");
    });
  });

  describe("rejects wildcard in non-leading position", () => {
    test.each([["api.*.com"], ["api.com.*"]])("rejects %s", (pattern) => {
      expectInvalid(pattern);
    });
  });

  describe("rejects IP addresses", () => {
    test.each([
      ["192.168.1.1", /ip/i],
      ["127.0.0.1", undefined],
      ["::1", /ip/i],
      ["2001:db8::1", /ip/i],
    ])("rejects %s", (pattern, reason) => {
      expectInvalid(pattern, reason);
    });
  });

  describe("rejects private TLDs", () => {
    test.each([
      ["*.local"],
      ["*.internal"],
      ["*.localhost"],
      ["foo.local"],
      ["foo.internal"],
      ["foo.localhost"],
    ])("rejects %s", (pattern) => {
      expectInvalid(pattern);
    });
  });

  describe("rejects cloud metadata hostnames", () => {
    test.each([
      ["metadata.google.internal"],
      ["instance-data.ec2.internal"],
    ])("rejects %s", (pattern) => {
      expectInvalid(pattern);
    });
  });

  describe("rejects empty and malformed patterns", () => {
    test("rejects empty string", () => {
      expectInvalid("");
    });

    test.each([
      ["https://api.example.com", /protocol/i],
      ["api.example.com/path", /path/i],
      ["api.example.com?query=1", /query/i],
      ["api.example.com:8080", /port/i],
    ])("rejects %s", (pattern, reason) => {
      expectInvalid(pattern, reason);
    });
  });
});

describe("matchesAllowedHost", () => {
  describe("exact matching", () => {
    test("exact match", () => {
      expect(matchesAllowedHost("api.example.com", ["api.example.com"])).toBe(true);
    });

    test("case-insensitive exact match", () => {
      expect(matchesAllowedHost("API.Example.COM", ["api.example.com"])).toBe(true);
    });

    test("strips trailing dot from hostname", () => {
      expect(matchesAllowedHost("api.example.com.", ["api.example.com"])).toBe(true);
    });

    test("exact match doesn't match subdomain", () => {
      expect(matchesAllowedHost("sub.api.example.com", ["api.example.com"])).toBe(false);
    });

    test("exact match doesn't match parent domain", () => {
      expect(matchesAllowedHost("example.com", ["api.example.com"])).toBe(false);
    });
  });

  describe("wildcard matching", () => {
    test("wildcard matches one subdomain level", () => {
      expect(matchesAllowedHost("foo.example.com", ["*.example.com"])).toBe(true);
    });

    test("wildcard matches multiple subdomain levels", () => {
      expect(matchesAllowedHost("a.b.example.com", ["*.example.com"])).toBe(true);
    });

    test("wildcard does not match bare domain", () => {
      expect(matchesAllowedHost("example.com", ["*.example.com"])).toBe(false);
    });

    test("wildcard is case-insensitive", () => {
      expect(matchesAllowedHost("FOO.Example.COM", ["*.example.com"])).toBe(true);
    });
  });

  describe("no match", () => {
    test("no match returns false", () => {
      expect(matchesAllowedHost("other.com", ["api.example.com"])).toBe(false);
    });

    test("empty patterns returns false", () => {
      expect(matchesAllowedHost("api.example.com", [])).toBe(false);
    });
  });

  describe("multiple patterns", () => {
    test("matches against multiple patterns — first matches", () => {
      expect(matchesAllowedHost("api.example.com", ["api.example.com", "other.com"])).toBe(true);
    });

    test("matches against multiple patterns — second matches", () => {
      expect(matchesAllowedHost("other.com", ["api.example.com", "other.com"])).toBe(true);
    });

    test("matches against multiple patterns — none match", () => {
      expect(matchesAllowedHost("nope.com", ["api.example.com", "other.com"])).toBe(false);
    });
  });

  describe("port handling", () => {
    test("port in hostname is stripped before matching exact", () => {
      expect(matchesAllowedHost("api.weather.com:8080", ["api.weather.com"])).toBe(true);
    });

    test("port with wildcard pattern", () => {
      expect(matchesAllowedHost("sub.example.com:443", ["*.example.com"])).toBe(true);
    });
  });

  describe("IDN/punycode", () => {
    test("ASCII hostnames compared normally", () => {
      expect(matchesAllowedHost("xn--nxasmq6b.com", ["xn--nxasmq6b.com"])).toBe(true);
    });
  });
});
