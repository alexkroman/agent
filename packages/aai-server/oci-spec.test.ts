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

  it("sets Deno command with container-internal paths and no --allow-env flag", () => {
    const spec = buildOciSpec(baseOpts);
    expect(spec.process.args).toEqual([
      "/bin/deno",
      "run",
      "--v8-flags=--max-heap-size=64",
      "--no-prompt",
      "/harness.mjs",
    ]);
  });

  it("sets minimal process.env", () => {
    const spec = buildOciSpec(baseOpts);
    expect(spec.process.env).toEqual(["PATH=/usr/bin:/bin", "HOME=/tmp", "NO_COLOR=1"]);
  });

  it("drops all capabilities", () => {
    const spec = buildOciSpec(baseOpts);
    const caps = spec.process.capabilities;
    expect(caps.bounding).toEqual([]);
    expect(caps.effective).toEqual([]);
    expect(caps.permitted).toEqual([]);
    expect(caps.inheritable).toEqual([]);
    expect(caps.ambient).toEqual([]);
  });

  it("sets default rlimits (no RLIMIT_AS — V8 max-heap-size handles memory)", () => {
    const spec = buildOciSpec(baseOpts);
    const rlimits = spec.process.rlimits;
    const rlimitTypes = rlimits.map((r) => r.type);
    expect(rlimitTypes).not.toContain("RLIMIT_AS");
    expect(rlimits).toContainEqual({ type: "RLIMIT_NPROC", hard: 32, soft: 32 });
    expect(rlimits).toContainEqual({ type: "RLIMIT_CPU", hard: 60, soft: 60 });
    expect(rlimits).toContainEqual({ type: "RLIMIT_NOFILE", hard: 256, soft: 256 });
  });

  it("applies operator overrides to rlimits", () => {
    const spec = buildOciSpec({
      ...baseOpts,
      limits: { memoryLimitBytes: 134_217_728, pidLimit: 64, cpuTimeLimitSecs: 120 },
    });
    expect(spec.process.rlimits).toContainEqual({ type: "RLIMIT_NPROC", hard: 64, soft: 64 });
    expect(spec.process.rlimits).toContainEqual({ type: "RLIMIT_CPU", hard: 120, soft: 120 });
  });

  it("scales V8 max-heap-size with memory limit", () => {
    const spec = buildOciSpec({ ...baseOpts, limits: { memoryLimitBytes: 134_217_728 } });
    expect(spec.process.args).toContain("--v8-flags=--max-heap-size=128");
  });

  it("applies tmpfs size override to mount options", () => {
    const spec = buildOciSpec({ ...baseOpts, limits: { tmpfsSizeBytes: 20_971_520 } });
    const tmpfsMount = spec.mounts.find((m) => m.destination === "/tmp");
    expect(tmpfsMount?.options).toContain("size=20m");
  });

  it("includes seccomp denylist with all expected syscalls", () => {
    const spec = buildOciSpec(baseOpts);
    const { seccomp } = spec.linux;
    expect(seccomp.defaultAction).toBe("SCMP_ACT_ALLOW");
    expect(seccomp.syscalls).toHaveLength(1);
    expect(seccomp.syscalls[0]).toMatchObject({
      action: "SCMP_ACT_ERRNO",
      errnoRet: 1,
    });
    const deniedNames = seccomp.syscalls[0]?.names ?? [];
    expect(deniedNames).toContain("ptrace");
    expect(deniedNames).toContain("mount");
    expect(deniedNames).toContain("unshare");
    expect(deniedNames).toContain("setns");
    expect(deniedNames).toContain("bpf");
    expect(deniedNames).toContain("userfaultfd");
    expect(deniedNames).toContain("kexec_load");
    expect(deniedNames).toHaveLength(26);
  });

  it("masks sensitive /proc paths", () => {
    const spec = buildOciSpec(baseOpts);
    expect(spec.linux.maskedPaths).toContain("/proc/kcore");
    expect(spec.linux.maskedPaths).toContain("/proc/keys");
    expect(spec.linux.readonlyPaths).toContain("/proc/sys");
  });

  it("mounts rootfs as read-only", () => {
    const spec = buildOciSpec(baseOpts);
    expect(spec.root.readonly).toBe(true);
  });

  it("mounts /tmp with noexec, nosuid, nodev", () => {
    const spec = buildOciSpec(baseOpts);
    const tmpfs = spec.mounts.find((m) => m.destination === "/tmp");
    expect(tmpfs?.options).toContain("noexec");
    expect(tmpfs?.options).toContain("nosuid");
    expect(tmpfs?.options).toContain("nodev");
  });

  it("mounts only /dev/null, /dev/zero, /dev/urandom as devices", () => {
    const spec = buildOciSpec(baseOpts);
    const devMounts = spec.mounts
      .filter((m) => m.destination.startsWith("/dev/") && m.type === "bind")
      .map((m) => m.destination)
      .sort((a, b) => a.localeCompare(b));
    expect(devMounts).toEqual(["/dev/null", "/dev/urandom", "/dev/zero"]);
  });

  it("overlays /dev with tmpfs before device bind mounts", () => {
    const spec = buildOciSpec(baseOpts);
    const devTmpfs = spec.mounts.find((m) => m.destination === "/dev" && m.type === "tmpfs");
    expect(devTmpfs).toBeDefined();
    expect(devTmpfs?.options).toContain("noexec");
    // /dev tmpfs must come before /dev/* bind mounts
    const devTmpfsIdx = spec.mounts.findIndex(
      (m) => m.destination === "/dev" && m.type === "tmpfs",
    );
    const devNullIdx = spec.mounts.findIndex((m) => m.destination === "/dev/null");
    expect(devTmpfsIdx).toBeLessThan(devNullIdx);
  });

  it("sets oomScoreAdj to 1000", () => {
    const spec = buildOciSpec(baseOpts);
    expect(spec.process.oomScoreAdj).toBe(1000);
  });

  it("includes pid, mount, ipc, uts namespaces but not network", () => {
    const spec = buildOciSpec(baseOpts);
    const nsTypes = spec.linux.namespaces.map((n) => n.type);
    expect(nsTypes).toContain("pid");
    expect(nsTypes).toContain("mount");
    expect(nsTypes).toContain("ipc");
    expect(nsTypes).toContain("uts");
    expect(nsTypes).not.toContain("network");
  });

  it("sets terminal to false", () => {
    const spec = buildOciSpec(baseOpts);
    expect(spec.process.terminal).toBe(false);
  });

  it("uses container-internal paths in process.args, not host paths", () => {
    const spec = buildOciSpec(baseOpts);
    expect(spec.process.args[0]).toBe("/bin/deno");
    expect(spec.process.args.at(-1)).toBe("/harness.mjs");
  });

  it("adds read-only bind mounts for deno binary and harness", () => {
    const spec = buildOciSpec(baseOpts);
    const denoMount = spec.mounts.find((m) => m.destination === "/bin/deno");
    expect(denoMount).toEqual({
      destination: "/bin/deno",
      type: "bind",
      source: "/rootfs/bin/deno",
      options: ["ro"],
    });
    const harnessMount = spec.mounts.find((m) => m.destination === "/harness.mjs");
    expect(harnessMount).toEqual({
      destination: "/harness.mjs",
      type: "bind",
      source: "/rootfs/harness.mjs",
      options: ["ro"],
    });
  });

  it("allows overriding container-internal paths", () => {
    const spec = buildOciSpec({
      ...baseOpts,
      containerDenoPath: "/usr/bin/deno",
      containerHarnessPath: "/app/harness.mjs",
    });
    expect(spec.process.args[0]).toBe("/usr/bin/deno");
    expect(spec.process.args.at(-1)).toBe("/app/harness.mjs");
    const denoMount = spec.mounts.find((m) => m.destination === "/usr/bin/deno");
    expect(denoMount).toBeDefined();
    expect(denoMount?.source).toBe("/rootfs/bin/deno");
    const harnessMount = spec.mounts.find((m) => m.destination === "/app/harness.mjs");
    expect(harnessMount).toBeDefined();
    expect(harnessMount?.source).toBe("/rootfs/harness.mjs");
  });
});
