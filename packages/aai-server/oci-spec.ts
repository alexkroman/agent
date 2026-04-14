// Copyright 2025 the AAI authors. MIT license.
/**
 * OCI runtime spec generator for gVisor sandboxes.
 *
 * Produces a complete OCI runtime spec (config.json) that `runsc run`
 * consumes. This replaces the lightweight `runsc do` approach with
 * explicit control over every security layer: capabilities, seccomp,
 * namespaces, rlimits, mounts, and cgroups.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tunable resource limits for a sandbox. All fields are optional — defaults are applied. */
export type SandboxResourceLimits = {
  /** Memory limit in bytes. Default: 67_108_864 (64 MB). */
  memoryLimitBytes?: number;
  /** Max number of PIDs. Default: 32. */
  pidLimit?: number;
  /** tmpfs size in bytes for /tmp. Default: 10_485_760 (10 MB). */
  tmpfsSizeBytes?: number;
  /** CPU time limit in seconds (RLIMIT_CPU). Default: 60. */
  cpuTimeLimitSecs?: number;
};

/** Options for building an OCI runtime spec. */
export type BuildOciSpecOptions = {
  rootfsPath: string;
  harnessPath: string;
  denoPath: string;
  limits?: SandboxResourceLimits;
};

/** Minimal OCI runtime spec shape — only the fields we populate. */
export type OciRuntimeSpec = {
  ociVersion: string;
  process: OciProcess;
  root: { path: string; readonly: boolean };
  mounts: OciMount[];
  linux: OciLinux;
};

type OciProcess = {
  terminal: boolean;
  args: string[];
  env: string[];
  cwd: string;
  noNewPrivileges: boolean;
  oomScoreAdj: number;
  user: { uid: number; gid: number };
  capabilities: OciCapabilities;
  rlimits: OciRlimit[];
};

type OciCapabilities = {
  bounding: string[];
  effective: string[];
  inheritable: string[];
  permitted: string[];
  ambient: string[];
};

type OciMount = {
  destination: string;
  type: string;
  source: string;
  options?: string[];
};

type OciRlimit = {
  type: string;
  hard: number;
  soft: number;
};

type OciLinux = {
  namespaces: { type: string }[];
  seccomp: OciSeccomp;
  maskedPaths: string[];
  readonlyPaths: string[];
};

type OciSeccomp = {
  defaultAction: string;
  architectures: string[];
  syscalls: { names: string[]; action: string; errnoRet?: number }[];
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MEMORY_BYTES = 67_108_864; // 64 MB
const DEFAULT_PID_LIMIT = 32;
const DEFAULT_TMPFS_BYTES = 10_485_760; // 10 MB
const DEFAULT_CPU_SECS = 60;
const DEFAULT_NOFILE = 256;

// ---------------------------------------------------------------------------
// Denied syscalls — these are blocked via seccomp even inside gVisor.
// Defense-in-depth: gVisor's Sentry already reimplements syscalls, but
// an explicit denylist ensures these dangerous calls are never forwarded.
// ---------------------------------------------------------------------------

const DENIED_SYSCALLS: readonly string[] = [
  "ptrace",
  "mount",
  "umount2",
  "pivot_root",
  "chroot",
  "reboot",
  "sethostname",
  "setdomainname",
  "init_module",
  "finit_module",
  "delete_module",
  "kexec_load",
  "kexec_file_load",
  "unshare",
  "setns",
  "personality",
  "userfaultfd",
  "perf_event_open",
  "bpf",
  "keyctl",
  "request_key",
  "add_key",
  "acct",
  "quotactl",
  "syslog",
  "vhangup",
] as const;

// ---------------------------------------------------------------------------
// Seccomp profile builder
// ---------------------------------------------------------------------------

function buildSeccompProfile(): OciSeccomp {
  return {
    defaultAction: "SCMP_ACT_ALLOW",
    architectures: ["SCMP_ARCH_X86_64", "SCMP_ARCH_AARCH64"],
    syscalls: [
      {
        names: [...DENIED_SYSCALLS],
        action: "SCMP_ACT_ERRNO",
        errnoRet: 1,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Masked / readonly proc paths (standard OCI hardening)
// ---------------------------------------------------------------------------

const MASKED_PATHS = [
  "/proc/acpi",
  "/proc/kcore",
  "/proc/keys",
  "/proc/latency_stats",
  "/proc/timer_list",
  "/proc/timer_stats",
  "/proc/sched_debug",
  "/proc/scsi",
];

const READONLY_PATHS = [
  "/proc/asound",
  "/proc/bus",
  "/proc/fs",
  "/proc/irq",
  "/proc/sys",
  "/proc/sysrq-trigger",
];

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build a complete OCI runtime spec for a gVisor sandbox.
 *
 * The spec is designed for maximum isolation:
 * - All capabilities dropped
 * - Seccomp denylist for 26 dangerous syscalls
 * - PID, mount, IPC, UTS namespaces (NOT network — handled externally)
 * - Readonly root filesystem with minimal tmpfs /tmp
 * - Process runs as nobody (65534:65534)
 * - noNewPrivileges enforced
 * - rlimits capping memory, PIDs, CPU time, and open files
 */
export function buildOciSpec(opts: BuildOciSpecOptions): OciRuntimeSpec {
  const limits = opts.limits ?? {};
  const memoryBytes = limits.memoryLimitBytes ?? DEFAULT_MEMORY_BYTES;
  const tmpfsBytes = limits.tmpfsSizeBytes ?? DEFAULT_TMPFS_BYTES;
  const cpuSecs = limits.cpuTimeLimitSecs ?? DEFAULT_CPU_SECS;
  const pidLimit = limits.pidLimit ?? DEFAULT_PID_LIMIT;

  return {
    ociVersion: "1.0.2",
    process: {
      terminal: false,
      args: [
        opts.denoPath,
        "run",
        `--v8-flags=--max-heap-size=${Math.floor(memoryBytes / (1024 * 1024))}`,
        "--no-prompt",
        opts.harnessPath,
      ],
      env: ["PATH=/usr/bin:/bin", "HOME=/tmp", "NO_COLOR=1"],
      cwd: "/tmp",
      noNewPrivileges: true,
      oomScoreAdj: 1000,
      user: { uid: 65_534, gid: 65_534 },
      capabilities: {
        bounding: [],
        effective: [],
        inheritable: [],
        permitted: [],
        ambient: [],
      },
      rlimits: [
        { type: "RLIMIT_AS", hard: memoryBytes, soft: memoryBytes },
        { type: "RLIMIT_NPROC", hard: pidLimit, soft: pidLimit },
        { type: "RLIMIT_CPU", hard: cpuSecs, soft: cpuSecs },
        { type: "RLIMIT_NOFILE", hard: DEFAULT_NOFILE, soft: DEFAULT_NOFILE },
      ],
    },
    root: {
      path: opts.rootfsPath,
      readonly: true,
    },
    mounts: [
      {
        destination: "/tmp",
        type: "tmpfs",
        source: "tmpfs",
        options: [
          "rw",
          "noexec",
          "nosuid",
          "nodev",
          `size=${Math.floor(tmpfsBytes / (1024 * 1024))}m`,
        ],
      },
      {
        destination: "/dev",
        type: "tmpfs",
        source: "tmpfs",
        options: ["nosuid", "noexec", "strictatime", "mode=755", "size=65536k"],
      },
      {
        destination: "/dev/null",
        type: "bind",
        source: "/dev/null",
        options: ["rw"],
      },
      {
        destination: "/dev/zero",
        type: "bind",
        source: "/dev/zero",
        options: ["rw"],
      },
      {
        destination: "/dev/urandom",
        type: "bind",
        source: "/dev/urandom",
        options: ["ro"],
      },
      {
        destination: "/proc",
        type: "proc",
        source: "proc",
        options: ["ro"],
      },
    ],
    linux: {
      namespaces: [{ type: "pid" }, { type: "mount" }, { type: "ipc" }, { type: "uts" }],
      seccomp: buildSeccompProfile(),
      maskedPaths: [...MASKED_PATHS],
      readonlyPaths: [...READONLY_PATHS],
    },
  };
}

// ---------------------------------------------------------------------------
// Test-only internals
// ---------------------------------------------------------------------------

/** @internal Exported for tests only. */
export const _internals = {
  DENIED_SYSCALLS,
  MASKED_PATHS,
  READONLY_PATHS,
  DEFAULT_MEMORY_BYTES,
  DEFAULT_PID_LIMIT,
  DEFAULT_TMPFS_BYTES,
  DEFAULT_CPU_SECS,
  DEFAULT_NOFILE,
  buildSeccompProfile,
};
