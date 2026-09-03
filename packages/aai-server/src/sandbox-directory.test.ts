// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { agentSandboxName, createMemorySandboxDirectory } from "./sandbox-directory.ts";

describe("agentSandboxName", () => {
  test("is stable for the same deploy — every replica computes the same name", () => {
    expect(agentSandboxName("contact-form", 3)).toBe(agentSandboxName("contact-form", 3));
  });

  /**
   * A blue-green handover boots the replacement while the old resident still
   * drains, so a slug legitimately has two live sandboxes for minutes. A
   * version-less name would collide and the handover would fail.
   */
  test("distinguishes versions of the same slug", () => {
    expect(agentSandboxName("contact-form", 3)).not.toBe(agentSandboxName("contact-form", 4));
  });

  test("distinguishes slugs", () => {
    expect(agentSandboxName("a", 1)).not.toBe(agentSandboxName("b", 1));
  });

  // Slugs run to 64 chars, so the slug is hashed: a bounded, charset-safe
  // name is one less thing to be surprised by. The dashboard reads the TAGS.
  test("is bounded and charset-safe regardless of the slug", () => {
    const name = agentSandboxName("x".repeat(64), 1234);
    expect(name).toMatch(/^agent-[0-9a-f]{16}-v1234$/);
    expect(name.length).toBeLessThanOrEqual(32);
  });
});

describe("createMemorySandboxDirectory", () => {
  test("reports no peer by default — a single process has none", async () => {
    const directory = createMemorySandboxDirectory();
    expect(await directory.find("slug", 1)).toBeNull();
  });

  test("finds an injected peer for the exact (slug, version)", async () => {
    const directory = createMemorySandboxDirectory();
    const entry = {
      sessionUrl: "wss://peer.test:443/websocket",
      guestOrigin: "wss://peer.test:443",
    };
    directory.setPeer("slug", 2, entry);
    expect(await directory.find("slug", 2)).toEqual(entry);
    // Version-exact: a peer on another deploy is not a match.
    expect(await directory.find("slug", 1)).toBeNull();
    expect(await directory.find("slug", 3)).toBeNull();
  });
});
