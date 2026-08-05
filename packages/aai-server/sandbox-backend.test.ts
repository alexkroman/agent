// Copyright 2026 the AAI authors. MIT license.
/**
 * Tests for sandbox backend selection: the SANDBOX_BACKEND override, the
 * production guarantee, and the local-dev default.
 */

import { describe, expect, it } from "vitest";
import { describeSandboxBackend, resolveSandboxBackend } from "./sandbox-backend.ts";

/** Env shape where local dev is on (no SUPABASE_STORAGE_BUCKET). */
const DEV_ENV: NodeJS.ProcessEnv = {};
const PROD_ENV: NodeJS.ProcessEnv = { SUPABASE_STORAGE_BUCKET: "aai-blobs" };

describe("resolveSandboxBackend", () => {
  it.each(["modal", "subprocess"] as const)(
    "honors an explicit SANDBOX_BACKEND=%s override",
    (backend) => {
      expect(resolveSandboxBackend({ ...DEV_ENV, SANDBOX_BACKEND: backend })).toBe(backend);
    },
  );

  it("lets the override win over the production default", () => {
    expect(resolveSandboxBackend({ ...PROD_ENV, SANDBOX_BACKEND: "subprocess" })).toBe(
      "subprocess",
    );
  });

  it("normalizes SANDBOX_BACKEND whitespace and case", () => {
    expect(resolveSandboxBackend({ SANDBOX_BACKEND: " SubProcess " })).toBe("subprocess");
  });

  it("throws on an unknown SANDBOX_BACKEND instead of silently picking a default", () => {
    expect(() => resolveSandboxBackend({ SANDBOX_BACKEND: "docker" })).toThrow(
      /Unknown SANDBOX_BACKEND "docker"/,
    );
  });

  it("rejects the removed apple-container backend", () => {
    // The local-container middle tier is gone; a stale
    // SANDBOX_BACKEND=apple-container must fail loudly, not fall back.
    expect(() => resolveSandboxBackend({ SANDBOX_BACKEND: "apple-container" })).toThrow(
      /Unknown SANDBOX_BACKEND "apple-container"/,
    );
  });

  it("defaults local dev to the subprocess backend", () => {
    expect(resolveSandboxBackend(DEV_ENV)).toBe("subprocess");
  });

  it("never selects a host-local backend outside local dev", () => {
    expect(resolveSandboxBackend(PROD_ENV)).toBe("modal");
  });

  it("treats AAI_LOCAL_DEV=1 as local dev even with storage configured", () => {
    expect(resolveSandboxBackend({ ...PROD_ENV, AAI_LOCAL_DEV: "1" })).toBe("subprocess");
  });
});

describe("describeSandboxBackend", () => {
  it("explains every branch so the boot log can name a cause", () => {
    expect(describeSandboxBackend(DEV_ENV).reason).toBe("local dev default");
    expect(describeSandboxBackend(PROD_ENV).reason).toBe("not local dev");
    expect(describeSandboxBackend({ SANDBOX_BACKEND: "modal" }).reason).toBe(
      "SANDBOX_BACKEND override",
    );
  });
});
