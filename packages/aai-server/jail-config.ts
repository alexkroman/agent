// Copyright 2025 the AAI authors. MIT license.
/**
 * nsjail protobuf text config builder.
 *
 * Generates a config file for nsjail that enforces:
 * - Read-only mount namespace with minimal bind-mounts
 * - PID, network, user, and mount namespace isolation
 * - seccomp-bpf syscall allowlist
 * - All capabilities dropped
 * - cgroup v2 memory and PID limits
 */

import { buildSeccompPolicy } from "./seccomp-policy.ts";

export interface JailOptions {
  /** Absolute path to the Rust V8 binary. */
  binaryPath: string;
  /** Directory for the UDS socket (bind-mounted read-write). */
  socketDir: string;
  /** Total memory limit in MB (Rust runtime + V8 heap). */
  memoryLimitMb: number;
  /** Short sandbox ID for unique paths (max 8 hex chars). */
  sandboxId: string;
}

/**
 * Build an nsjail protobuf text format config string.
 */
export function buildJailConfig(options: JailOptions): string {
  const { binaryPath, socketDir, memoryLimitMb, sandboxId } = options;
  const memoryBytes = memoryLimitMb * 1024 * 1024;
  const seccompPolicy = buildSeccompPolicy();

  const escapedPolicy = seccompPolicy
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");

  return `
name: "aai-sandbox-${sandboxId}"
description: "AAI agent sandbox jail"

mode: ONCE
hostname: "sandbox"
cwd: "/tmp"

clone_newuser: true
clone_newns: true
clone_newpid: true
clone_newipc: true
clone_newnet: true
clone_newuts: true
clone_newcgroup: true

keep_caps: false
disable_proc: false

rlimit_as_type: HARD
rlimit_core_type: HARD
rlimit_cpu_type: HARD
rlimit_fsize_type: HARD
rlimit_nofile_type: HARD
rlimit_nproc_type: HARD

cgroup_mem_max: ${memoryBytes}
cgroup_pids_max: 1

envar: "SECURE_EXEC_V8_TOKEN"
envar: "SECURE_EXEC_V8_CODEC"
envar: "SECURE_EXEC_V8_MAX_SESSIONS"

mount {
  src: "/lib"
  dst: "/lib"
  is_bind: true
  rw: false
  mandatory: false
}

mount {
  src: "/lib64"
  dst: "/lib64"
  is_bind: true
  rw: false
  mandatory: false
}

mount {
  src: "/usr/lib"
  dst: "/usr/lib"
  is_bind: true
  rw: false
  mandatory: false
}

mount {
  src: "${binaryPath}"
  dst: "/bin/secure-exec-v8"
  is_bind: true
  rw: false
}

mount {
  src: "${socketDir}"
  dst: "${socketDir}"
  is_bind: true
  rw: true
}

mount {
  dst: "/proc"
  fstype: "proc"
  rw: false
}

mount {
  dst: "/tmp"
  fstype: "tmpfs"
  rw: true
}

exec_bin {
  path: "/bin/secure-exec-v8"
}

seccomp_string: "${escapedPolicy}"
`.trim();
}
