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

const PACKAGES = path.resolve(import.meta.dirname, "../..");

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
 * The relative half of the module graph — `from "./x.ts"` and
 * `await import("./x.ts")`, resolved to absolute paths.
 *
 * Relative ONLY, and that is a deliberate limit rather than an omission: a
 * cross-package specifier would have to be resolved through the owning
 * package's `exports` map, which is a resolver this text scan has no business
 * growing. What it costs is that a chain LEAVING a package has to be re-anchored
 * by a test in the package that OWNS the case list — which is the healthier rule
 * anyway, and is what `aai-runtime`'s own suites do for the journal's.
 */
function moduleDeps(file: string, text: string): string[] {
  const specifiers = [
    ...text.matchAll(/from\s+"(\.[^"]+)"/g),
    ...text.matchAll(/import\("(\.[^"]+)"\)/g),
  ];
  return specifiers.flatMap((m) => (m[1] ? [path.resolve(path.dirname(file), m[1])] : []));
}

/**
 * Every file a test of the given shape can REACH, transitively.
 *
 * This is what makes the two assertions below survive a case list being SPLIT.
 * They used to ask whether the case list's own name appears inside a
 * `*.test.ts`, which encodes an assumption a split breaks: the journal's list
 * outgrew the 500-line cap, so `journalRunConformance` and
 * `journalWaitConformance` are composed by `journal-conformance.ts` and invoked
 * THROUGH it — demonstrably run, and reported as possibly-dead. Four case lists
 * hit that cap in one evening, and `store-conformance-cases.ts` is the next one
 * to hit it, at which point the very gate guarding this registry would have
 * reported the registry as broken.
 *
 * Widening it to "invoked from anywhere" would have given the property up: a
 * case list composed by a module nothing imports would pass. Reachability keeps
 * it — the invocation still has to be found in a file a test can get to, so an
 * aggregator nobody imports is as dead as it was before.
 *
 * The approximation being made, stated because it is one: this is the module
 * graph, not the call graph. A module that a test imports and CALLS INTO is not
 * distinguished from one it merely imports, so a case list invoked inside a
 * reached module is taken to run. Nothing in production ever invokes a case
 * list — only a test or an aggregator does — so the set of files that can
 * contain `xConformance(` at all is already the honest one.
 */
function reachableFrom(isSeed: (file: string) => boolean): Set<string> {
  const seen = new Set<string>();
  const queue = FILES.filter(isSeed);
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const dep of moduleDeps(file, READ.get(file) ?? "")) {
      if (READ.has(dep)) queue.push(dep);
    }
  }
  return seen;
}

const isTest = (file: string): boolean => /\.test\.ts$/.test(file);
const isScenario = (file: string): boolean => /\.scenario\.test\.ts$/.test(file);
/** Reached from a UNIT test — the memory arm, which runs unconditionally. */
const UNIT_REACH = reachableFrom((f) => isTest(f) && !isScenario(f));
/** Reached from a SCENARIO test — the arm whose quiet absence this gate is for. */
const SCENARIO_REACH = reachableFrom(isScenario);
/** Reached from any test at all. */
const TEST_REACH = reachableFrom(isTest);

/** Does any file in `reach` invoke `fn`? */
function invokedIn(reach: Set<string>, fn: string): boolean {
  for (const file of reach) {
    if (READ.get(file)?.includes(`${fn}(`)) return true;
  }
  return false;
}

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
    // A SEPARATE list, because "has no twin" and "its twin is not written yet"
    // are different claims and collapsing them would let the first one absorb
    // unfinished work indefinitely. An entry here is a DEBT — when the twin lands
    // it moves into `STORE_CONTRACTS`, and this list should be empty again.
    //
    // `createMemoryJournal` was here and has MOVED: `createPostgresJournal` is
    // its twin, registered above and driven by `workflow-journal.scenario.test.ts`.
    // The progress channel is what is left — a run's narration is still memory-only
    // on every deployment, which is the smaller half of the same gap.
    const pendingTwin = ["createMemoryStreams"];
    const unregistered = declared.filter(
      (n) => !(registered.has(n) || noTwin.includes(n) || pendingTwin.includes(n)),
    );
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
      // Reached FROM each tier rather than named inside it — see
      // {@link reachableFrom}. An aggregator is how a case list at the
      // file-length cap gets run, and it is still the tier's own file that has
      // to reach it.
      expect.soft(invokedIn(UNIT_REACH, fn), `${contract.contract} memory arm`).toBe(true);
      expect.soft(invokedIn(SCENARIO_REACH, fn), `${contract.contract} stack arm`).toBe(true);
    }
  });

  test("no conformance case list is declared without being registered", () => {
    // The reverse direction: a case list somebody wrote and nobody wired is as
    // silent as a contract nobody registered.
    const lists = [...EXPORTED].filter((n) => n.endsWith("Conformance"));
    expect(lists.length).toBeGreaterThan(0);
    for (const fn of lists) {
      // "Reached from a test, possibly through an AGGREGATOR" — not "invoked
      // from a `*.test.ts`", which asks whether the list was written before
      // anyone split it, and not "invoked from anywhere", which would pass a
      // list composed by a module nothing imports. See {@link reachableFrom}.
      expect.soft(invokedIn(TEST_REACH, fn), `${fn} is reached from a test`).toBe(true);
    }
  });

  test("the module graph really RESOLVES, so a narrowed scan cannot pass quietly", () => {
    // The floor under {@link reachableFrom}. Every assertion above is a boolean
    // per name, so the two ways this degenerates need saying:
    //
    // - **the graph resolves nothing** — `moduleDeps`' patterns stop matching,
    //   the reach collapses to the seed files, and the two tests silently go
    //   back to the direct-name scan they replaced. That direction is RED rather
    //   than green (an aggregated list stops being found), so it announces
    //   itself — but it announces itself as "the journal's cases are dead",
    //   which is the wrong finding, and this is the assertion that names the
    //   real one.
    // - **the seeds vanish** — no file matches `*.test.ts` and every name is
    //   reported unreached.
    const testFiles = FILES.filter(isTest);
    expect(testFiles.length).toBeGreaterThan(200);
    expect(FILES.filter(isScenario).length).toBeGreaterThan(10);
    // Strictly larger than the seeds: the graph pulled in modules the tests
    // import. Measured 1,489 files reached from 662 test files, and 393 from 36
    // scenario files, out of 1,811 in the tree.
    expect(TEST_REACH.size).toBeGreaterThan(testFiles.length);
    expect(SCENARIO_REACH.size).toBeGreaterThan(FILES.filter(isScenario).length);
    // And a CEILING on the scenario reach, which is the direction that would
    // make the stack-arm assertion vacuous rather than merely wrong: if it
    // reached most of the tree, "runs over the stack arm" would be satisfied by
    // any invocation anywhere. It reaches 22% today.
    expect(SCENARIO_REACH.size).toBeLessThan(FILES.length / 2);
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
      "aai-server/src/store-conformance.ts",
      "aai-studio-server/src/studio-store-conformance.ts",
    ]) {
      const text = READ.get(path.join(PACKAGES, name));
      expect(text, name).toBeDefined();
      const code = (text ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect.soft(code, name).not.toMatch(/createFakeSql|createDispatchingSql|createRecordingSql/);
    }
  });
});
