// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, it } from "vitest";
import { buildOciSpec, type SandboxResourceLimits } from "./oci-spec.ts";

// Verify the type is importable (used in sandbox-vm.ts consumers).
const _typeCheck: SandboxResourceLimits = {};

describe("buildOciSpec", () => {
  const baseOpts = {
    rootfsPath: "/rootfs",
    harnessPath: "/rootfs/harness.mjs",
    denoPath: "/rootfs/bin/deno",
  };

  it("returns a valid OCI runtime spec with defaults", () => {
    const spec = buildOciSpec(baseOpts);
    expect(spec.ociVersion).toBe("1.0.2");
    expect(spec.process.cwd).toBe("/tmp");
    expect(spec.process.noNewPrivileges).toBe(true);
    expect(spec.process.user).toEqual({ uid: 65_534, gid: 65_534 });
    expect(spec.root).toEqual({ path: "/rootfs", readonly: true });
  });

  it("sets Deno command with no --allow-env flag", () => {
    const spec = buildOciSpec(baseOpts);
    expect(spec.process.args).toEqual([
      "/rootfs/bin/deno",
      "run",
      "--v8-flags=--max-heap-size=64",
      "--no-prompt",
      "/rootfs/harness.mjs",
    ]);
  });

  it("sets minimal process.env", () => {
    const spec = buildOciSpec(baseOpts);
    expect(spec.process.env).toEqual(["PATH=/usr/bin:/bin", "HOME=/tmp", "NO_COLOR=1"]);
  });
});
