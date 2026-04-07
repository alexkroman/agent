// Copyright 2025 the AAI authors. MIT license.
/**
 * Seccomp-bpf policy builder for nsjail.
 *
 * Reads the checked-in syscall allowlist and generates nsjail's
 * Kafel-format seccomp policy string. Default action is KILL —
 * any syscall not on the allowlist terminates the process.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface SeccompAllowlist {
  _comment: string;
  syscalls: string[];
}

export function loadAllowlist(): SeccompAllowlist {
  return require("./seccomp-allowlist.json") as SeccompAllowlist;
}

/**
 * Build a Kafel-format seccomp policy string for nsjail.
 */
export function buildSeccompPolicy(): string {
  const allowlist = loadAllowlist();
  const lines = [
    "POLICY seccomp_policy {",
    `  ALLOW { ${allowlist.syscalls.join(", ")} }`,
    "}",
    "DEFAULT KILL",
    "USE seccomp_policy",
  ];
  return lines.join("\n");
}
