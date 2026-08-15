// Copyright 2026 the AAI authors. MIT license.
/**
 * The gate under the conformance gate.
 *
 * A conformance table that lists only its memory arm reports the same green as
 * one listing both, and a contract nobody registered reports nothing at all —
 * the exact silent-success shape `api-surface-file.test.ts` and
 * `api-contracts-gate.test.ts` exist for one level up. Collapsing to two arms
 * makes it MORE load-bearing, not less: there is no third arm left to notice the
 * absence of the second.
 *
 * So this asserts three things about the registry in `store-conformance.ts`:
 *
 * 1. **Every two-implementation pair in the repo is REGISTERED.** A fourteenth
 *    contract cannot arrive unparried — it either gets a conformance table or it
 *    gets a `conformance: false` with a reason a reviewer can argue with.
 * 2. **Every registered name really exists.** A typo'd entry would otherwise
 *    match nothing and pass, which is the same failure as a `konsistent`
 *    convention whose glob matches no files.
 * 3. **Every conformable contract really runs over BOTH arms** — its case list is
 *    invoked from a unit test (the memory arm, unconditional) and from a
 *    `*.scenario.test.ts` (the stack arm). This is the one that catches the
 *    failure the plan was written about: a table with the stack arm quietly
 *    missing.
 *
 * **Everything here is a TEXT scan**, deliberately. Two of the contracts live in
 * `aai-studio-server`, and `aai-server` may not import that package — the
 * dependency runs the other way. Reading the tree as text respects that boundary
 * the same way `sync-agent-guide.mjs` and `guard-invariants.mjs` rule 12 do. A
 * test rather than a `guard-invariants` rule for the reason the plan gives: this
 * is a set comparison over declarations, not a pattern a line either matches or
 * does not.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { STORE_CONTRACTS } from "./store-conformance.ts";

const PACKAGES = path.resolve(import.meta.dirname, "..");

/** Every `.ts` file in every package, excluding build output and node_modules. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
    }
  };
  for (const pkg of readdirSync(PACKAGES)) {
    const full = path.join(PACKAGES, pkg);
    if (statSync(full).isDirectory()) walk(full);
  }
  return out;
}

const FILES = sourceFiles();
const READ = new Map(FILES.map((f) => [f, readFileSync(f, "utf-8")]));
/** Only non-test source declares a store; a test that declares one is a fake. */
const SOURCE = [...READ].filter(([f]) => !/\.test(-d)?\.ts$/.test(f));

/** `export function foo` / `export const foo` across the tree. */
function exportedNames(entries: [string, string][]): Set<string> {
  const names = new Set<string>();
  for (const [, text] of entries) {
    for (const m of text.matchAll(/^export (?:async )?(?:function|const) ([A-Za-z_$][\w$]*)/gm)) {
      if (m[1]) names.add(m[1]);
    }
  }
  return names;
}

const EXPORTED = exportedNames(SOURCE);

/**
 * The MEMORY halves the repo declares, by naming convention.
 *
 * `createMemory*` catches eleven of the thirteen; `localSlugLock` and
 * `createRateLimiter` are the two that carry no prefix (the rate limiter's twin
 * takes the `Pg` prefix instead), so a scan for the convention alone finds
 * eleven and reports the other two as absent contracts. They are listed because
 * a naming convention that has exceptions has to name them somewhere, and here
 * is better than in a reviewer's memory.
 */
const UNPREFIXED_MEMORY_HALVES = ["localSlugLock", "createRateLimiter"];

describe("the store conformance registry", () => {
  test("every two-implementation pair in the repo is registered", () => {
    const registered = new Set(STORE_CONTRACTS.map((c) => c.memory));
    const declared = [...EXPORTED].filter(
      (n) => n.startsWith("createMemory") || UNPREFIXED_MEMORY_HALVES.includes(n),
    );
    // Not every memory implementation has a production twin — the sandbox
    // directory is test-only (dev and the subprocess backend get NO directory:
    // a single process has no peers), and the platform event bus's production
    // half is Supabase Realtime, whose behaviour is a change STREAM rather than a
    // store contract and is covered by `realtime-rls.scenario.test.ts`. Both are
    // named here rather than silently absent, because "has no twin" is a claim.
    const noTwin = ["createMemorySandboxDirectory", "createMemoryPlatformEvents"];
    const unregistered = declared.filter((n) => !(registered.has(n) || noTwin.includes(n)));
    expect(unregistered).toEqual([]);
  });

  test("every registered factory name really exists in source", () => {
    // A typo'd entry matches nothing and would otherwise pass, which is the
    // failure a registry is supposed to prevent rather than reproduce.
    const missing = STORE_CONTRACTS.flatMap((c) =>
      [c.memory, c.pg]
        .filter((name) => !EXPORTED.has(name))
        .map((name) => `${c.contract}: ${name}`),
    );
    expect(missing).toEqual([]);
  });

  test("a non-conformable contract says WHY, and a conformable one does not", () => {
    for (const contract of STORE_CONTRACTS) {
      const exempt = contract.conformance === false;
      // An exemption with no reason is an omission wearing a decision's clothes.
      expect.soft(Boolean(contract.why), `${contract.contract} why`).toBe(exempt);
    }
  });

  test("every conformable contract runs over BOTH arms", () => {
    // The assertion the whole plan is about. A case list invoked only from a unit
    // file is the memory arm alone, and the run looks identical — so the arms are
    // read out of the tree rather than trusted.
    const unitFiles = [...READ].filter(([f]) => /\.test\.ts$/.test(f) && !/\.scenario\./.test(f));
    const scenarioFiles = [...READ].filter(([f]) => /\.scenario\.test\.ts$/.test(f));
    const invokedIn = (entries: [string, string][], fn: string): boolean =>
      entries.some(([, text]) => text.includes(`${fn}(`));

    // Each conformable contract's case list, by the one convention that ties a
    // registry entry to its spec: the contract name in camelCase + `Conformance`.
    const CASE_LISTS: Record<string, string> = {
      workspace: "workspaceStoreConformance",
      chat: "chatStoreConformance",
      agents: "agentRowsConformance",
      secrets: "secretStoreConformance",
      "rate-limit": "rateLimiterConformance",
      "studio-session-registry": "studioSessionRegistryConformance",
      "studio-preview-queue": "previewQueueConformance",
    };

    for (const contract of STORE_CONTRACTS) {
      if (contract.conformance === false) continue;
      const fn = CASE_LISTS[contract.contract];
      // A conformable contract with no case list named here is exactly the
      // "nobody registered it" hole, one level in.
      expect.soft(fn, `${contract.contract} has a named case list`).toBeDefined();
      if (!fn) continue;
      expect.soft(invokedIn(unitFiles, fn), `${contract.contract} memory arm`).toBe(true);
      expect.soft(invokedIn(scenarioFiles, fn), `${contract.contract} stack arm`).toBe(true);
    }
  });

  test("no conformance case list is declared without being registered", () => {
    // The reverse direction: a case list somebody wrote and nobody wired is as
    // silent as a contract nobody registered.
    const lists = [...EXPORTED].filter((n) => n.endsWith("Conformance"));
    expect(lists.length).toBeGreaterThan(0);
    const unitFiles = [...READ].filter(([f]) => /\.test\.ts$/.test(f));
    for (const fn of lists) {
      expect
        .soft(
          unitFiles.some(([, text]) => text.includes(`${fn}(`)),
          `${fn} is invoked somewhere`,
        )
        .toBe(true);
    }
  });

  test("the fake SqlExec is not an arm of any conformance table", () => {
    // It holds no data semantics and never claimed to; what it uniquely asserts
    // is that a store issued the STATEMENTS it should have. Listed beside real
    // databases it was the arm a reader trusted MOST because of its `postgres`
    // label, while being unable to represent a single bug that has shipped.
    //
    // Comments are stripped before matching, because this module's own doc
    // comment EXPLAINS the fake at length: unstripped, the guard scored its own
    // rationale as a violation. Third or fourth time this repo has paid for that
    // — see the `check-escape-hatches.mjs` markdown exclusion and
    // `guard-invariants.mjs`'s `SELF_REFERENTIAL` set.
    for (const name of [
      "store-conformance.ts",
      "../aai-studio-server/studio-store-conformance.ts",
    ]) {
      const text = READ.get(path.join(PACKAGES, "aai-server", name));
      expect(text, name).toBeDefined();
      const code = (text ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect.soft(code, name).not.toMatch(/createFakeSql|createDispatchingSql|createRecordingSql/);
    }
  });
});
