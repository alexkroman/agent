// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { matchesAllowedHost, validateAllowedHostPattern } from "./allowed-hosts.ts";

describe("validateAllowedHostPattern", () => {
  describe("valid patterns", () => {
    test("accepts exact hostname", () => {
      expect(validateAllowedHostPattern("api.weather.com")).toEqual({
        valid: true,
      });
    });

    test("accepts exact hostname without subdomain", () => {
      expect(validateAllowedHostPattern("example.com")).toEqual({ valid: true });
    });

    test("accepts wildcard subdomain", () => {
      expect(validateAllowedHostPattern("*.mycompany.com")).toEqual({
        valid: true,
      });
    });

    test("accepts wildcard with multiple domain levels", () => {
      expect(validateAllowedHostPattern("*.api.mycompany.com")).toEqual({
        valid: true,
      });
    });
  });

  describe("rejects bare wildcards", () => {
    test("rejects bare *", () => {
      const result = validateAllowedHostPattern("*");
      expect(result.valid).toBe(false);
      expect((result as { valid: false; reason: string }).reason).toMatch(/bare/i);
    });

    test("rejects bare **", () => {
      const result = validateAllowedHostPattern("**");
      expect(result.valid).toBe(false);
    });
  });

  describe("rejects wildcard in non-leading position", () => {
    test("rejects wildcard in middle position", () => {
      const result = validateAllowedHostPattern("api.*.com");
      expect(result.valid).toBe(false);
    });

    test("rejects wildcard at end", () => {
      const result = validateAllowedHostPattern("api.com.*");
      expect(result.valid).toBe(false);
    });
  });

  describe("rejects IP addresses", () => {
    test("rejects IPv4 address", () => {
      const result = validateAllowedHostPattern("192.168.1.1");
      expect(result.valid).toBe(false);
      expect((result as { valid: false; reason: string }).reason).toMatch(/ip/i);
    });

    test("rejects IPv4 loopback", () => {
      const result = validateAllowedHostPattern("127.0.0.1");
      expect(result.valid).toBe(false);
    });

    test("rejects IPv6 address", () => {
      const result = validateAllowedHostPattern("::1");
      expect(result.valid).toBe(false);
    });

    test("rejects full IPv6 address", () => {
      const result = validateAllowedHostPattern("2001:db8::1");
      expect(result.valid).toBe(false);
    });
  });

  describe("rejects private TLDs", () => {
    test("rejects *.local", () => {
      const result = validateAllowedHostPattern("*.local");
      expect(result.valid).toBe(false);
    });

    test("rejects *.internal", () => {
      const result = validateAllowedHostPattern("*.internal");
      expect(result.valid).toBe(false);
    });

    test("rejects *.localhost", () => {
      const result = validateAllowedHostPattern("*.localhost");
      expect(result.valid).toBe(false);
    });

    test("rejects exact match foo.local", () => {
      const result = validateAllowedHostPattern("foo.local");
      expect(result.valid).toBe(false);
    });

    test("rejects exact match foo.internal", () => {
      const result = validateAllowedHostPattern("foo.internal");
      expect(result.valid).toBe(false);
    });

    test("rejects exact match foo.localhost", () => {
      const result = validateAllowedHostPattern("foo.localhost");
      expect(result.valid).toBe(false);
    });
  });

  describe("rejects cloud metadata hostnames", () => {
    test("rejects metadata.google.internal", () => {
      const result = validateAllowedHostPattern("metadata.google.internal");
      expect(result.valid).toBe(false);
    });

    test("rejects instance-data.ec2.internal", () => {
      const result = validateAllowedHostPattern("instance-data.ec2.internal");
      expect(result.valid).toBe(false);
    });
  });

  describe("rejects empty and malformed patterns", () => {
    test("rejects empty string", () => {
      const result = validateAllowedHostPattern("");
      expect(result.valid).toBe(false);
    });

    test("rejects pattern with protocol", () => {
      const result = validateAllowedHostPattern("https://api.example.com");
      expect(result.valid).toBe(false);
      expect((result as { valid: false; reason: string }).reason).toMatch(/protocol/i);
    });

    test("rejects pattern with path", () => {
      const result = validateAllowedHostPattern("api.example.com/path");
      expect(result.valid).toBe(false);
      expect((result as { valid: false; reason: string }).reason).toMatch(/path/i);
    });

    test("rejects pattern with query", () => {
      const result = validateAllowedHostPattern("api.example.com?query=1");
      expect(result.valid).toBe(false);
      expect((result as { valid: false; reason: string }).reason).toMatch(/query/i);
    });

    test("rejects pattern with port", () => {
      const result = validateAllowedHostPattern("api.example.com:8080");
      expect(result.valid).toBe(false);
      expect((result as { valid: false; reason: string }).reason).toMatch(/port/i);
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
