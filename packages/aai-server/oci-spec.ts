// Copyright 2025 the AAI authors. MIT license.
/**
 * OCI runtime spec generator for gVisor sandboxes.
 *
 * Produces a complete OCI runtime spec (config.json) that `runsc run`
 * consumes. This replaces the lightweight `runsc do` approach with
 * explicit control over every security layer: capabilities, seccomp,
 * namespaces, rlimits, mounts, and cgroups.
 */

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

export type BuildOciSpecOptions = {
  rootfsPath: string;
  denoPath: string;
  harnessPath: string;
  limits?: SandboxResourceLimits;
};

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

const DEFAULT_MEMORY_BYTES = 67_108_864; // 64 MB
const DEFAULT_PID_LIMIT = 32;
const DEFAULT_TMPFS_BYTES = 10_485_760; // 10 MB
const DEFAULT_CPU_SECS = 60;
const DEFAULT_NOFILE = 256;

// Defense-in-depth: gVisor's Sentry already reimplements syscalls, but
// an explicit denylist ensures these dangerous calls are never forwarded.
const DENIED_SYSCALLS = [
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
];

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
  const {
    memoryLimitBytes: memoryBytes = DEFAULT_MEMORY_BYTES,
    tmpfsSizeBytes: tmpfsBytes = DEFAULT_TMPFS_BYTES,
    cpuTimeLimitSecs: cpuSecs = DEFAULT_CPU_SECS,
    pidLimit = DEFAULT_PID_LIMIT,
  } = opts.limits ?? {};
  const memoryMb = Math.floor(memoryBytes / (1024 * 1024));
  const tmpfsMb = Math.floor(tmpfsBytes / (1024 * 1024));
  return {
    ociVersion: "1.0.2",
    process: {
      terminal: false,
      args: [
        opts.denoPath,
        "run",
        `--v8-flags=--max-heap-size=${memoryMb}`,
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
      // Note: RLIMIT_AS is intentionally omitted. It limits virtual address
      // space, not resident memory, and V8 reserves ~1 GB of virtual memory
      // at startup. The --max-heap-size V8 flag (in process.args) is the
      // correct mechanism for limiting Deno/V8 memory usage.
      rlimits: [
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
        options: ["rw", "noexec", "nosuid", "nodev", `size=${tmpfsMb}m`],
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
      seccomp: {
        defaultAction: "SCMP_ACT_ALLOW",
        architectures: ["SCMP_ARCH_X86_64", "SCMP_ARCH_AARCH64"],
        syscalls: [{ names: DENIED_SYSCALLS, action: "SCMP_ACT_ERRNO", errnoRet: 1 }],
      },
      maskedPaths: MASKED_PATHS,
      readonlyPaths: READONLY_PATHS,
    },
  };
}
