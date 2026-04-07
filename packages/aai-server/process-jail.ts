// Copyright 2025 the AAI authors. MIT license.
/**
 * OS-level process jail for the secure-exec Rust V8 runtime.
 *
 * On Linux with nsjail installed, wraps the Rust binary in an nsjail
 * sandbox with namespace isolation, seccomp, capability dropping, and
 * cgroup resource limits. On macOS or when nsjail is unavailable,
 * skips the jail with a warning.
 *
 * Integration: set process.env.SECURE_EXEC_V8_WRAPPER to the wrapper
 * script path before any secure-exec module loads. The patched
 * resolveBinaryPath() in @secure-exec/v8 picks it up.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { JailOptions } from "./jail-config.ts";
import { buildJailConfig } from "./jail-config.ts";

export type { JailOptions } from "./jail-config.ts";

export interface JailedLauncher {
  /** Path to the wrapper shell script. */
  binaryPath: string;
  /** Remove temp wrapper script and config on shutdown. */
  cleanup(): Promise<void>;
}

let nsjailPath: string | null | undefined;

function findNsjail(): string | null {
  if (nsjailPath !== undefined) return nsjailPath;
  try {
    nsjailPath = execFileSync("which", ["nsjail"], {
      encoding: "utf-8",
    }).trim();
    return nsjailPath;
  } catch {
    nsjailPath = null;
    return null;
  }
}

/**
 * Check if OS-level process jail is available.
 * Requires Linux + nsjail on $PATH.
 */
export function isJailAvailable(): boolean {
  if (process.platform !== "linux") return false;
  return findNsjail() !== null;
}

/**
 * Create a jailed launcher that wraps the Rust V8 binary in nsjail.
 *
 * Writes a temp wrapper script and nsjail config file. The wrapper
 * script path should be set as process.env.SECURE_EXEC_V8_WRAPPER
 * before secure-exec loads.
 */
export async function createJailedLauncher(options: JailOptions): Promise<JailedLauncher> {
  const nsjail = findNsjail();
  if (!nsjail) throw new Error("nsjail not found on $PATH");

  const jailDir = path.join(options.socketDir, `aai-jail-${options.sandboxId}`);
  await fs.mkdir(jailDir, { recursive: true, mode: 0o700 });

  // Write nsjail config
  const configPath = path.join(jailDir, "jail.cfg");
  const config = buildJailConfig(options);
  await fs.writeFile(configPath, config, { mode: 0o600 });

  // Write wrapper script
  const wrapperPath = path.join(jailDir, "secure-exec-v8");
  const wrapperScript = [
    "#!/bin/sh",
    `exec ${nsjail} --config ${configPath} -- /bin/secure-exec-v8`,
  ].join("\n");
  await fs.writeFile(wrapperPath, wrapperScript, { mode: 0o700 });

  return {
    binaryPath: wrapperPath,
    async cleanup() {
      await fs.rm(jailDir, { recursive: true, force: true });
    },
  };
}

/**
 * Initialize the process jail if available.
 *
 * Must be called before any secure-exec module is imported.
 * Sets process.env.SECURE_EXEC_V8_WRAPPER if jail is available.
 *
 * @returns cleanup function, or null if jail unavailable.
 */
export async function initProcessJail(options: {
  binaryPath: string;
  memoryLimitMb: number;
}): Promise<JailedLauncher | null> {
  if (!isJailAvailable()) {
    console.warn(
      `OS-level process jail unavailable (platform: ${process.platform}). ` +
        "Relying on secure-exec isolation only.",
    );
    return null;
  }

  const os = await import("node:os");
  const socketDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-jail-"));
  const sandboxId = path.basename(socketDir).slice(-8);

  const launcher = await createJailedLauncher({
    binaryPath: options.binaryPath,
    socketDir,
    memoryLimitMb: options.memoryLimitMb,
    sandboxId,
  });

  process.env.SECURE_EXEC_V8_WRAPPER = launcher.binaryPath;
  console.info("Process jail initialized", { wrapper: launcher.binaryPath });

  return launcher;
}
