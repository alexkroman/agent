// Copyright 2025 the AAI authors. MIT license.
/**
 * Unit tests for sandbox-vm.ts factory logic.
 *
 * Verifies the production safety guard (refuses to run without gVisor),
 * dev-mode fallback warning, and KV parameter validation schemas.
 * All tests run on any platform — no gVisor or Docker required.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// ── KV schema tests (schemas are private, so we re-declare the same shapes) ──

const KvGetParamsSchema = z.object({ key: z.string().min(1) });
const KvSetParamsSchema = z.object({ key: z.string().min(1), value: z.unknown() });
const KvDelParamsSchema = z.object({ key: z.string().min(1) });

describe("KV parameter validation schemas", () => {
  describe("KvGetParamsSchema", () => {
    it("accepts valid key", () => {
      expect(KvGetParamsSchema.safeParse({ key: "my-key" }).success).toBe(true);
    });

    it("rejects empty key", () => {
      expect(KvGetParamsSchema.safeParse({ key: "" }).success).toBe(false);
    });

    it("rejects missing key", () => {
      expect(KvGetParamsSchema.safeParse({}).success).toBe(false);
    });

    it("rejects non-string key", () => {
      expect(KvGetParamsSchema.safeParse({ key: 123 }).success).toBe(false);
    });
  });

  describe("KvSetParamsSchema", () => {
    it("accepts valid key + value", () => {
      expect(KvSetParamsSchema.safeParse({ key: "k", value: "v" }).success).toBe(true);
    });

    it("accepts null value", () => {
      expect(KvSetParamsSchema.safeParse({ key: "k", value: null }).success).toBe(true);
    });

    it("accepts complex object value", () => {
      expect(KvSetParamsSchema.safeParse({ key: "k", value: { nested: [1, 2] } }).success).toBe(
        true,
      );
    });

    it("rejects empty key", () => {
      expect(KvSetParamsSchema.safeParse({ key: "", value: "v" }).success).toBe(false);
    });

    it("rejects missing key", () => {
      expect(KvSetParamsSchema.safeParse({ value: "v" }).success).toBe(false);
    });
  });

  describe("KvDelParamsSchema", () => {
    it("accepts valid key", () => {
      expect(KvDelParamsSchema.safeParse({ key: "my-key" }).success).toBe(true);
    });

    it("rejects empty key", () => {
      expect(KvDelParamsSchema.safeParse({ key: "" }).success).toBe(false);
    });
  });
});

// ── Factory logic tests ─────────────────────────────────────────────────────

describe("createSandboxVm factory", () => {
  const savedNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = savedNodeEnv;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("throws in production when gVisor is not available", async () => {
    process.env.NODE_ENV = "production";

    // Mock gVisor as unavailable
    vi.doMock("./gvisor.ts", () => ({
      isGvisorAvailable: () => false,
      createGvisorSandbox: vi.fn(),
    }));

    const { createSandboxVm } = await import("./sandbox-vm.ts");

    await expect(
      createSandboxVm({
        slug: "test",
        workerCode: "export default {}",
        env: {},
        harnessPath: "/tmp/harness.mjs",
      }),
    ).rejects.toThrow("gVisor (runsc) is required in production");
  });

  it("logs warning in dev mode when gVisor unavailable", async () => {
    process.env.NODE_ENV = "development";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(/* noop */ () => undefined);

    // Mock gVisor as unavailable
    vi.doMock("./gvisor.ts", () => ({
      isGvisorAvailable: () => false,
      createGvisorSandbox: vi.fn(),
    }));

    // Mock child_process.spawn to avoid real process spawning
    vi.doMock("node:child_process", async (importOriginal) => {
      const orig = await importOriginal<typeof import("node:child_process")>();
      const { EventEmitter } = await import("node:events");
      const { Readable, Writable } = await import("node:stream");
      return {
        ...orig,
        spawn: vi.fn(() => {
          const proc = new EventEmitter() as import("node:child_process").ChildProcess;
          proc.stdin = new Writable({
            write(_c, _e, cb) {
              cb();
            },
          });
          proc.stdout = new Readable({
            read() {
              /* no-op */
            },
          });
          proc.stderr = new Readable({
            read() {
              /* no-op */
            },
          });
          proc.kill = vi.fn();
          Object.defineProperty(proc, "pid", { value: 99_999, writable: true });
          Object.defineProperty(proc, "exitCode", { value: null, writable: true });
          return proc;
        }),
      };
    });

    const { createSandboxVm } = await import("./sandbox-vm.ts");

    // createDevSandbox will hang on bundle/load since the fake process
    // never responds — that's OK, we're testing the warning is logged
    // before the RPC call.
    const promise = createSandboxVm({
      slug: "test",
      workerCode: "export default {}",
      env: {},
      harnessPath: "/nonexistent/harness.mjs",
    });

    // Give it a tick to execute synchronous code (warning is logged
    // before the async configureSandbox call)
    await new Promise((r) => setTimeout(r, 50));

    expect(warnSpy).toHaveBeenCalledWith(
      "[sandbox] WARNING: gVisor not available. Running without sandbox isolation (dev mode only).",
    );

    // Clean up the hanging promise (it will never resolve since
    // the mock process doesn't respond to NDJSON)
    promise.catch(() => {
      /* expected to hang */
    });
  });

  it("error message includes install instructions", async () => {
    process.env.NODE_ENV = "production";

    vi.doMock("./gvisor.ts", () => ({
      isGvisorAvailable: () => false,
      createGvisorSandbox: vi.fn(),
    }));

    const { createSandboxVm } = await import("./sandbox-vm.ts");

    await expect(
      createSandboxVm({
        slug: "test",
        workerCode: "export default {}",
        env: {},
        harnessPath: "/tmp/harness.mjs",
      }),
    ).rejects.toThrow("https://gvisor.dev/docs/user_guide/install/");
  });
});
