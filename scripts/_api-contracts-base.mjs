#!/usr/bin/env node

/**
 * The contract tree as it stood at the MERGE-BASE with `origin/main` — what
 * this branch is measured against (G4: at most one epoch, and at most one
 * revision, per capability per branch).
 *
 * The gate used to measure against the working tree alone, so a branch that
 * moved one capability three times minted three epochs: `aai:llm` went v4 to
 * v7 on one PR and v7's hash equalled v3's. An epoch is a promise made on
 * `main`; the ones a branch mints and then supersedes were never made to
 * anybody. So `--bump` and `--update` look here first, and an epoch or revision
 * that does not exist at the base is REWRITTEN in place rather than stacked on.
 *
 * Falls back gracefully: `--base <ref>` names the ref (or `none`), else
 * `origin/main`, else `main`; a shallow clone or a tree with neither
 * answers `null`, and every caller then treats the working tree as the base —
 * the old behaviour, one epoch per `--bump`.
 */

import { execFileSync } from "node:child_process";

import { latestEpoch, ROOT, rel } from "./_api-contracts-tree.mjs";

const git = (args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

let requested;
let cached;

/**
 * Measure against `ref` instead of `origin/main`/`main` — the CLI's `--base`.
 * `none` disables the base entirely.
 */
export function useBase(ref) {
  requested = ref;
  cached = undefined;
}

function resolveBase() {
  if (requested === "none") return null;
  for (const ref of requested === undefined ? ["origin/main", "main"] : [requested]) {
    try {
      const sha = git(["merge-base", "HEAD", ref]).trim();
      if (sha !== "") return sha;
    } catch {
      // Not a ref here (a shallow clone, a fork without `main`) — try the next.
    }
  }
  return null;
}

/** The merge-base commit, or `null` when there is nothing to measure against. */
export function mergeBase() {
  if (cached === undefined) cached = resolveBase();
  return cached;
}

/** One file's text at the base, or `undefined` when it did not exist there. */
export function atBase(path) {
  const base = mergeBase();
  if (base === null) return;
  try {
    return git(["show", `${base}:${rel(path)}`]);
  } catch (error) {
    // Not in the tree at the base: a new capability, or a new package.
    if (error instanceof Error) return;
    throw error;
  }
}

const parsed = (text) => (text === undefined ? undefined : JSON.parse(text));

/**
 * One package's contract table at the base, or `undefined` — which means
 * either no base (see {@link mergeBase}) or a package that did not carry
 * contracts yet. Callers ask {@link hasBase} to tell the two apart.
 *
 * @returns {import("./_api-contracts-tree.mjs").ContractTable | undefined}
 */
export const baseTable = (pkg) => parsed(atBase(pkg.tablePath));

/** @returns {import("./_api-contracts-tree.mjs").EpochRecord | undefined} */
export const baseEpoch = (path) => parsed(atBase(path));

export const hasBase = () => mergeBase() !== null;

/**
 * Where this branch stands against the base for one capability.
 *
 * `epochOnMain(v)` is the question every rewrite turns on: an epoch that
 * exists at the base is a promise and is only ever REVISED; one that does not
 * was minted on this branch and may be rewritten freely.
 */
export function branchState(pkg, capability) {
  if (!hasBase()) {
    return { base: null, epochOnMain: () => true, baseLatest: undefined };
  }
  const contract = baseTable(pkg)?.[capability];
  const baseLatest = contract === undefined ? 0 : latestEpoch(contract);
  return { base: contract ?? null, epochOnMain: (v) => v <= baseLatest, baseLatest };
}
