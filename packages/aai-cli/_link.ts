// Copyright 2025 the AAI authors. MIT license.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_PKGS = ["aai", "aai-ui"];

function getPackagesDir(): string {
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(cliDir, "..");
}

type DepRewriter = (currentVersion: string, localPath: string) => string | null;

function rewriteWorkspaceDeps(cwd: string, rewrite: DepRewriter, verb: string): void {
  const packagesDir = getPackagesDir();
  const pkgJsonPath = path.join(cwd, "package.json");
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  const deps = pkgJson.dependencies ?? {};
  const changed: string[] = [];

  for (const pkgDir of WORKSPACE_PKGS) {
    const localPath = path.join(packagesDir, pkgDir);
    const localPkg = JSON.parse(fs.readFileSync(path.join(localPath, "package.json"), "utf-8"));
    const name = localPkg.name as string;
    if (!deps[name]) continue;
    const newVersion = rewrite(deps[name], localPath);
    if (newVersion !== null) {
      deps[name] = newVersion;
      changed.push(name);
    }
  }

  if (changed.length === 0) {
    console.log(`No packages to ${verb}.`);
    return;
  }

  fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
  console.log(`${verb}: ${changed.join(", ")} → installing...`);
  execFileSync("npm", ["install"], { cwd, stdio: "inherit" });
}

export function runLinkCommand(cwd: string): void {
  rewriteWorkspaceDeps(cwd, (_cur, localPath) => `file:${localPath}`, "Linked");
}

export function runUnlinkCommand(cwd: string): void {
  rewriteWorkspaceDeps(cwd, (cur) => (cur.startsWith("file:") ? "*" : null), "Unlinked");
}
