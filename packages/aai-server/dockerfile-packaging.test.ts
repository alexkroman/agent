// Copyright 2025 the AAI authors. MIT license.
/**
 * Static check that the production image ships every file a runtime import
 * can reach.
 *
 * The final Dockerfile stage hand-picks what it copies out of the build
 * stage — almost all of it `dist/` — while what the server can actually
 * import at runtime is whatever each workspace package declares in
 * `exports`. Those two lists drift silently, and the drift only shows up in
 * production: `@alexkroman1/aai-ui/styles.css` is a package-root file rather
 * than a dist artifact, so the studio's client build (every generated
 * `client.tsx` imports it first, per the scaffold guide) died with
 * "Rolldown failed to resolve import" on the deployed server while every
 * local build passed.
 *
 * `docker-build.test.ts` catches this class by building the real image, but
 * that is the 10-minute docker tier gated on a running daemon — too slow to
 * be the guard rail for an omitted one-line COPY. This test is pure
 * fs/string work, so it runs in the normal unit tier on every `pnpm test`.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const serverDir = path.resolve(import.meta.dirname ?? ".");
const repoRoot = path.resolve(serverDir, "../..");

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), "utf-8"));
}

/** Strip a leading `/app/` or `./` so every path is image-root-relative. */
function normalize(p: string): string {
  return p
    .replace(/^\/app\//, "")
    .replace(/^\.\//, "")
    .replace(/^\//, "");
}

/** Image-relative paths one COPY line lands in the image (dirs keep `/`). */
function copyTargets(line: string): string[] {
  const match = /^COPY\s+(.+)$/.exec(line.trim());
  if (!match?.[1]) return [];
  // Drop flags (--from=..., --chown=...); the last remaining arg is the dest.
  const args = match[1].split(/\s+/).filter((arg) => !arg.startsWith("--"));
  const dest = args.pop();
  if (!dest) return [];
  const destDir = normalize(dest.endsWith("/") ? dest : `${dest}/`);
  const intoDir = dest.endsWith("/") || dest === ".";

  return args.map((src) => {
    const source = normalize(src);
    // Directory copy: contents land under dest, so dest is the prefix.
    if (source.endsWith("/")) return destDir;
    // A file copied into a directory keeps its basename; otherwise dest is
    // the full path it lands at.
    return intoDir ? destDir + path.basename(source) : normalize(dest);
  });
}

/**
 * Image-relative paths the final stage copies. Directories keep their
 * trailing slash so they can be matched as prefixes.
 */
function copiedPaths(dockerfile: string): string[] {
  const lines = dockerfile.split("\n");
  // Only the last stage contributes to the shipped image.
  const lastFrom = lines.reduce((acc, line, i) => (/^FROM\s/i.test(line) ? i : acc), -1);
  return lines.slice(lastFrom + 1).flatMap(copyTargets);
}

function isCovered(required: string, copied: string[]): boolean {
  return copied.some((entry) =>
    entry.endsWith("/") ? required.startsWith(entry) : entry === required,
  );
}

/** Every string leaf in an `exports` map, ignoring dev-only conditions. */
function exportTargets(exports: unknown): string[] {
  const targets: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      targets.push(node);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [condition, value] of Object.entries(node)) {
      // `@dev/source` resolves to TypeScript source, which the image never
      // runs — production resolution uses the `import`/`types` conditions.
      if (condition === "@dev/source") continue;
      walk(value);
    }
  };
  walk(exports);
  return targets;
}

/** Map package name → `packages/<dir>` for every workspace package. */
function workspaceDirs(): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const entry of fs.readdirSync(path.join(repoRoot, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(repoRoot, "packages", entry.name, "package.json");
    if (!fs.existsSync(manifest)) continue;
    const name = JSON.parse(fs.readFileSync(manifest, "utf-8")).name;
    if (typeof name === "string") dirs.set(name, entry.name);
  }
  return dirs;
}

const dockerfile = fs.readFileSync(path.join(serverDir, "Dockerfile"), "utf-8");
const copied = copiedPaths(dockerfile);
const dirs = workspaceDirs();
const workspaceDeps = Object.entries(
  (readJson("packages/aai-server/package.json").dependencies ?? {}) as Record<string, string>,
)
  .filter(([, range]) => range.startsWith("workspace:"))
  .map(([name]) => name);

describe("production image packaging", () => {
  test("the Dockerfile's final stage was parsed", () => {
    // Guards the rest of the suite: a parser that silently matches nothing
    // would make every coverage assertion below vacuously pass.
    expect(copied).toContain("node_modules/");
    expect(workspaceDeps.length).toBeGreaterThan(0);
  });

  test.each(workspaceDeps)("%s: every export target is copied into the image", (name) => {
    const dir = dirs.get(name);
    expect(dir, `no packages/* directory declares the name ${name}`).toBeDefined();

    const pkg = readJson(`packages/${dir}/package.json`);
    const required = exportTargets(pkg.exports)
      .filter((target) => target.startsWith("./"))
      // A wildcard subpath is satisfied by its containing directory.
      .map((target) => `packages/${dir}/${target.slice(2)}`.replace(/\*.*$/, ""));

    expect(required.length).toBeGreaterThan(0);
    const missing = [...new Set(required.filter((p) => !isCovered(p, copied)))];
    expect(missing).toEqual([]);
  });

  test.each(workspaceDeps)("%s: every copied export target exists in the repo", (name) => {
    // A target the image copies but the build never produces would fail the
    // COPY itself; this catches an `exports` entry pointing at nothing.
    const dir = dirs.get(name);
    const sources = exportTargets(readJson(`packages/${dir}/package.json`).exports)
      .filter((target) => target.startsWith("./") && !target.includes("*"))
      // dist/ only exists after a build, which unit tests don't require.
      .filter((target) => !target.startsWith("./dist/"));

    for (const target of sources) {
      const abs = path.join(repoRoot, "packages", String(dir), target.slice(2));
      expect(fs.existsSync(abs), `${name}: ${target} does not exist at ${abs}`).toBe(true);
    }
  });

  test.each(workspaceDeps)("%s: its peer dependencies survive the prod install", (name) => {
    // The studio bundles these packages into a published client, and the
    // client build resolves their peers from its build root — a scratch dir
    // under this package (see studio-workspace-dir.ts), so "resolvable" means
    // "a dependency of aai-server". The image's final `pnpm install --prod`
    // prunes devDependencies, so a peer satisfied only by the depending
    // package's own devDependency (React, in aai-ui) exists locally and is
    // gone in production: publishing died with "Rolldown failed to resolve
    // import react/jsx-runtime" while every local build passed.
    const pkg = readJson(`packages/${dirs.get(name)}/package.json`);
    const meta = (pkg.peerDependenciesMeta ?? {}) as Record<string, { optional?: boolean }>;
    const required = Object.keys((pkg.peerDependencies ?? {}) as Record<string, string>).filter(
      (peer) => !meta[peer]?.optional,
    );
    const prodDeps = Object.keys(readJson("packages/aai-server/package.json").dependencies ?? {});

    expect(required.filter((peer) => !prodDeps.includes(peer))).toEqual([]);
  });
});
