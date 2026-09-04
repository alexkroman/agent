// Copyright 2025 the AAI authors. MIT license.
/**
 * Trust rules for the platform URL a credential may be sent to.
 *
 * `.aai/project.json` is part of the working tree, so a cloned repo controls
 * its `serverUrl`. Commands pair that URL with the user's API key — and, for
 * `aai secret put`, with secret values — so an unapproved origin from the
 * config must be refused rather than silently trusted.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_SERVER, resolveServerUrl } from "./_agent.ts";
import { readProjectConfig, serverOrigin, writeProjectConfig } from "./_config.ts";
import { withTempDir } from "./_test-utils.ts";

// resolveServerUrl short-circuits to the dev server when running inside this
// monorepo, which would mask the config path these tests exercise. Stubbed
// per-test rather than assigned at module scope: process.env is shared by
// every test file in a vitest worker, and a stray AAI_NO_DEV would break
// _agent.test.ts's "dev mode takes priority" expectation.
beforeEach(() => {
  vi.stubEnv("AAI_NO_DEV", "1");
});

const EVIL = "https://attacker.example";

describe("resolveServerUrl: config-supplied origins", () => {
  test("refuses an unapproved origin from project.json", () => {
    expect(() => resolveServerUrl(undefined, EVIL)).toThrow(/Refusing to send your API key/);
  });

  test("names the offending origin and how to approve it", () => {
    expect(() => resolveServerUrl(undefined, EVIL)).toThrow(/attacker\.example/);
    expect(() => resolveServerUrl(undefined, EVIL)).toThrow(/--server/);
  });

  test("allows the shipped default platform without approval", () => {
    expect(resolveServerUrl(undefined, DEFAULT_SERVER)).toBe(DEFAULT_SERVER);
  });

  // Loopback is NOT implicitly trusted: `.aai/project.json` is repo content,
  // and a repo-supplied `http://localhost:<port>` would hand the API key (and
  // `aai secret` values) to whatever the attacker has listening on that local
  // port. `--server` approves a local origin like any other.
  test.each(["http://localhost:8080", "http://127.0.0.1:3000", "http://[::1]:3000"])(
    "refuses unapproved loopback from config: %s",
    (url: string) => {
      expect(() => resolveServerUrl(undefined, url)).toThrow(/Refusing to send your API key/);
    },
  );

  test("allows loopback once approved", () => {
    expect(resolveServerUrl(undefined, "http://127.0.0.1:3000", ["http://127.0.0.1:3000"])).toBe(
      "http://127.0.0.1:3000",
    );
  });

  test("allows an origin the user previously approved", () => {
    expect(resolveServerUrl(undefined, `${EVIL}/`, [EVIL])).toBe(EVIL);
  });

  test("approval is per-origin, not per-substring", () => {
    // Approving the real host must not also approve a lookalike.
    expect(() => resolveServerUrl(undefined, "https://attacker.example.evil.test", [EVIL])).toThrow(
      /Refusing/,
    );
  });

  test("rejects a non-URL serverUrl", () => {
    expect(() => resolveServerUrl(undefined, "not a url")).toThrow(/Invalid serverUrl/);
  });
});

describe("resolveServerUrl: explicit --server", () => {
  test("an explicit flag is trusted regardless of approvals", () => {
    // The flag is direct user intent, not repo content.
    expect(resolveServerUrl(EVIL, "https://other.example")).toBe(EVIL);
  });

  test("explicit flag wins over a config URL", () => {
    expect(resolveServerUrl("https://mine.example", EVIL)).toBe("https://mine.example");
  });
});

describe("resolveServerUrl: defaults", () => {
  test("falls back to the shipped default when no config exists", () => {
    expect(resolveServerUrl()).toBe(DEFAULT_SERVER);
  });
});

describe("serverOrigin", () => {
  test.each([
    ["https://a.example/path?q=1", "https://a.example"],
    ["http://localhost:8080/", "http://localhost:8080"],
  ])("returns the origin of %s", (url: string, expected: string) => {
    expect(serverOrigin(url)).toBe(expected);
  });

  // `new URL()` gives these the opaque origin "null", which must not flow on
  // as if it were a real origin.
  test.each(["file:///etc/passwd", "javascript:alert(1)", "not a url", "/relative"])(
    "rejects non-http(s): %s",
    (url: string) => {
      expect(serverOrigin(url)).toBeNull();
    },
  );
});

describe("readProjectConfig", () => {
  // A malformed serverUrl must not invalidate the whole file: returning null
  // would discard the slug, and a deploy with no slug generates a fresh one —
  // silently creating a duplicate agent and overwriting project.json.
  test("keeps the slug when serverUrl is unusable", async () => {
    await withTempDir(async (dir) => {
      await writeProjectConfig(dir, { slug: "my-agent", serverUrl: "not a url" });
      const config = await readProjectConfig(dir);
      expect(config?.slug).toBe("my-agent");
    });
  });

  test("the unusable serverUrl is then rejected at use time", () => {
    expect(() => resolveServerUrl(undefined, "not a url")).toThrow(/Invalid serverUrl/);
    expect(() => resolveServerUrl(undefined, "file:///etc/passwd")).toThrow(/Invalid serverUrl/);
  });
});
