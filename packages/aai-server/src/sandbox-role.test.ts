// Copyright 2026 the AAI authors. MIT license.
/** Tests for the sandbox observability identity: role inference + tag shape. */

import { describe, expect, it } from "vitest";
import { resolveSandboxRole, roleForSlug, sandboxTags } from "./sandbox-role.ts";

describe("roleForSlug", () => {
  it("labels preview slugs by their suffix", () => {
    expect(roleForSlug("contact-form-x7k2mq-preview")).toBe("preview");
    expect(roleForSlug("contact-form-x7k2mq")).toBe("agent");
    // Suffix must be terminal, not merely present.
    expect(roleForSlug("preview-tools")).toBe("agent");
  });
});

describe("resolveSandboxRole", () => {
  it("prefers an explicit role, then slug inference, then pool", () => {
    expect(resolveSandboxRole({ slug: "foo-preview", role: "studio" })).toBe("studio");
    expect(resolveSandboxRole({ slug: "foo-preview" })).toBe("preview");
    expect(resolveSandboxRole({ slug: "foo" })).toBe("agent");
    expect(resolveSandboxRole({})).toBe("studio");
  });
});

describe("sandboxTags", () => {
  it("always carries service + role, and slug only when known", () => {
    expect(sandboxTags("studio", "my-project")).toEqual({
      service: "aai-guest",
      role: "studio",
      slug: "my-project",
    });
    expect(sandboxTags("studio")).toEqual({ service: "aai-guest", role: "studio" });
  });
});
