// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import chalk from "chalk";
import semver from "semver";
import { interactive, warning } from "./_colors.ts";
import { execFileAsync } from "./_exec.ts";
import { info, error as logError, step } from "./_output.ts";

const REPO = "alexkroman/aai";
const VERSION_URL = `https://github.com/${REPO}/releases/download/latest/VERSION`;
const CHECK_TIMEOUT_MS = 3000;

function detectTarget(): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `aai-${os}-${arch}`;
}

async function checkForUpdate(currentVersion: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    const resp = await fetch(VERSION_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const remote = (await resp.text()).trim();
    if (semver.gt(remote, currentVersion)) return remote;
    return null;
  } catch {
    return null;
  }
}

async function doUpgrade(newVersion: string): Promise<boolean> {
  const target = detectTarget();
  const url = `https://github.com/${REPO}/releases/download/latest/${target}.tar.gz`;

  step("Download", `aai ${newVersion}`);

  const resp = await fetch(url);
  if (!resp.ok) {
    logError(`Download failed: ${resp.status} ${resp.statusText}`);
    return false;
  }

  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const tmp = await mkdtemp(path.join(tmpdir(), "aai-"));

  try {
    const tarPath = path.join(tmp, `${target}.tar.gz`);
    const arrayBuffer = await resp.arrayBuffer();
    await fs.writeFile(tarPath, Buffer.from(arrayBuffer));
    await execFileAsync("tar", ["xzf", tarPath, "-C", tmp]);

    const installDir = process.env.AAI_INSTALL_DIR || `${process.env.HOME}/.aai/bin`;
    const binPath = `${installDir}/aai`;

    await fs.copyFile(path.join(tmp, "aai"), binPath);
    await fs.chmod(binPath, 0o755);

    step("Updated", `aai to ${newVersion}`);
    return true;
  } catch (err) {
    logError(`Upgrade failed: ${err}`);
    return false;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Checks for a newer CLI release on GitHub and, if one is found, prompts the
 * user to upgrade in place. Downloads and replaces the current binary if the
 * user confirms. Exits the process after a successful upgrade.
 *
 * @param currentVersion The currently running CLI version (semver string).
 */
export async function promptUpgradeIfAvailable(currentVersion: string): Promise<void> {
  const newVersion = await checkForUpdate(currentVersion);
  if (!newVersion) return;

  console.log(
    `\n${warning("Update available:")} ${chalk.dim(currentVersion)} → ${chalk.bold(
      interactive(newVersion),
    )}`,
  );

  const { confirm } = await import("@inquirer/prompts");
  const confirmed = await confirm({ message: "Upgrade now?" });
  if (!confirmed) {
    info(chalk.dim(`Run aai again to upgrade later.`));
    return;
  }

  const ok = await doUpgrade(newVersion);
  if (ok) {
    info("Restart aai to use the new version.");
    process.exit(0);
  }
}
