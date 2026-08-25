// Copyright 2026 the AAI authors. MIT license.
/**
 * Tests for sandbox backend selection: the SANDBOX_BACKEND override, the
 * production guarantee, and the local-dev default.
 */

import { describe, expect, it } from "vitest";
import { describeSandboxBackend, resolveSandboxBackend } from "./sandbox-backend.ts";

/** A local run is DECLARED; anything else — an empty env included — is not. */
const DEV_ENV: NodeJS.ProcessEnv = { AAI_LOCAL_DEV: "1" };
const PROD_ENV: NodeJS.ProcessEnv = {};

describe("resolveSandboxBackend", () => {
  it.each(["modal", "microsandbox", "subprocess"] as const)(
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

  it("gives a declared local run the isolated microVM backend", () => {
    // Not `subprocess`: local dev used to default to the backend with NO
    // boundary, which meant the studio coding agent's `bash` and `run_code` ran
    // on the developer's machine as the server's uid unless somebody had opted
    // out. Trading away the security model should be a decision.
    expect(resolveSandboxBackend(DEV_ENV)).toBe("microsandbox");
  });

  it("reaches the isolation-free backend ONLY when it is named", () => {
    // The one way in, from either side of the local-dev declaration.
    expect(resolveSandboxBackend({ ...DEV_ENV, SANDBOX_BACKEND: "subprocess" })).toBe("subprocess");
    expect(resolveSandboxBackend({ ...PROD_ENV, SANDBOX_BACKEND: "subprocess" })).toBe(
      "subprocess",
    );
  });

  it("never selects a host-local backend without that declaration", () => {
    // An EMPTY env is the case that matters: the isolation-free backend must be
    // what someone asks for, never what a forgotten variable selects. The old
    // sentinel (`!SUPABASE_STORAGE_BUCKET`) made this exact env resolve
    // `subprocess`.
    expect(resolveSandboxBackend(PROD_ENV)).toBe("modal");
    expect(resolveSandboxBackend({ AAI_LOCAL_DEV: "0" })).toBe("modal");
  });

  it("is independent of where platform state lives", () => {
    // Running against the local Supabase stack must not demand Modal
    // credentials, and configuring no database must not hand out a host guest.
    expect(resolveSandboxBackend({ AAI_LOCAL_DEV: "1", SUPABASE_DB_URL: "postgres://x" })).toBe(
      "microsandbox",
    );
    expect(resolveSandboxBackend({ SUPABASE_STORAGE_BUCKET: "aai-blobs" })).toBe("modal");
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
