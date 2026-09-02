// Copyright 2026 the AAI authors. MIT license.
/**
 * The UNIT arm of the workflow-keys contract, plus the gate under the gate.
 *
 * **memory**, the reference, unconditionally. The Postgres arm is
 * `workflow-keys-conformance-postgres.scenario.test.ts`.
 *
 * ## What this arm can and CANNOT see
 *
 * It is the reference, so what it can see is the contract itself: every promise
 * `WorkflowKeyStore` makes, answered by a `Map`. That is the whole value of a
 * reference arm and it is also its whole limit — a `Map` cannot be wrong about
 * a database.
 *
 * What it cannot see, named because this file reports all of it as green:
 *
 * - **Whether the DDL runs at all.** `workflow-keys.test.ts` beside this asserts
 *   the statements a recording `Db` was handed, which is a claim about TEXT;
 *   `aai-server/workflow-keys.scenario.test.ts` is the only place a syntax error
 *   in `create table` or in the four-column `create index` fails anything.
 * - **Whether `on conflict (run_id) do nothing` is a no-op.** It is one only if
 *   the primary key really is on `run_id`, which is a property of the schema. The
 *   memory arm reaches the same behaviour through a `Set`, so the two AGREE here
 *   and only the Postgres arm can say the agreement is earned.
 * - **The ordering under a plan that has to SORT.** The lookup index already
 *   encodes `created_at desc, run_id desc`, so an index scan answers correctly
 *   even for a query that never asked — which is why `aai-server`'s suite runs
 *   the lookup a second time with index scans disabled. Nothing here bears on it.
 * - **`limit` as a bind parameter**, which Postgres resolves to `bigint`. A
 *   `slice` cannot be wrong about a driver.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createMemoryKeyStore } from "./workflow-keys.ts";
import {
  WORKFLOW_KEY_STORES,
  type WorkflowKeyArm,
  workflowKeyConformance,
  workflowKeyIds,
} from "./workflow-keys-conformance.ts";

/* -------------------------------------------------------------------------- */
/* The memory arm                                                             */
/* -------------------------------------------------------------------------- */

// ONE store across every case, exactly as the Postgres arm has to be. A fresh
// store per case would let a case that leaks state pass here and fail there.
const memoryStore = createMemoryKeyStore();

const memoryArm: WorkflowKeyArm = {
  label: "memory",
  keys: () => memoryStore,
  uid: workflowKeyIds("mem"),
};

workflowKeyConformance(memoryArm);

/* -------------------------------------------------------------------------- */
/* The gate under the gate                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A conformance table listing one of two arms reports the same green as one
 * listing both, and a store nobody registered reports nothing at all — the
 * silent-success shape `aai-server/store-conformance-registry.test.ts` exists
 * for one package over, and `journal-conformance.test.ts` and
 * `session-state-conformance.test.ts` beside this one. Everything here is a TEXT
 * scan, for the same reason it is there: a set comparison over declarations is
 * not a pattern a line either matches or does not, so it is a test rather than a
 * `guard-invariants` rule.
 */
describe("the workflow-keys conformance registry", () => {
  const HERE = import.meta.dirname;
  const FILES = readdirSync(HERE).filter((f) => f.endsWith(".ts"));
  const READ = new Map(FILES.map((f) => [f, readFileSync(path.join(HERE, f), "utf-8")]));
  const isTest = (file: string) => /\.test(-d)?\.ts$/.test(file);

  /** `export function foo` in one module. */
  function exportedFunctions(file: string): string[] {
    const source = READ.get(file) ?? "";
    return [...source.matchAll(/^export (?:async )?function ([A-Za-z_$][\w$]*)/gm)].flatMap((m) =>
      m[1] ? [m[1]] : [],
    );
  }

  test("every workflow-key store in the tree is registered", () => {
    // Discovery is by FACTORY NAME, like session state's sweep and unlike the
    // journal's filename scan — and here it is not a preference. Both
    // implementations live in ONE module (`workflow-keys.ts`), so there is no
    // `workflow-keys-<store>.ts` grammar for a filename scan to walk and no
    // konsistent convention deriving a factory name from a path; what keeps the
    // names recognisable is that the declaring module is PINNED by
    // `konsistent.json`'s `workflow-key-stores` convention, which requires
    // exactly these two exports to exist there. So a third store either lands in
    // that file under the same grammar and is found here, or lands in a new file
    // and is found here too.
    const declaring = FILES.filter((f) => !isTest(f) && exportedFunctions(f).some(isFactory));
    expect(declaring.length).toBeGreaterThan(0);
    const registered = new Set(WORKFLOW_KEY_STORES.map((s) => s.module));
    expect(declaring.filter((m) => !registered.has(m))).toEqual([]);
  });

  test("every registered factory really exists, in the module that claims it", () => {
    // A typo'd entry matches nothing and would otherwise pass, which is the
    // failure a registry is supposed to prevent rather than reproduce.
    const missing = WORKFLOW_KEY_STORES.filter(
      (s) => !exportedFunctions(s.module).includes(s.factory),
    ).map((s) => `${s.store}: ${s.factory} in ${s.module}`);
    expect(missing).toEqual([]);
  });

  test("both registered factories are found, and the scan sees no more", () => {
    // **This is the test that actually catches an unregistered store here, and
    // the module scan above is not.** A/B'd: deleting the `postgres` entry from
    // `WORKFLOW_KEY_STORES` leaves the first test GREEN, because both factories
    // live in ONE module and the surviving `memory` entry still registers it —
    // the module set is complete while the store set is not. That is the price
    // of the one-file shape, and it is why the FACTORY names are compared as a
    // set rather than the modules they sit in. Only this case failed.
    const found = FILES.filter((f) => !isTest(f)).flatMap((f) =>
      exportedFunctions(f).filter(isFactory),
    );
    // Both sides sorted CODE-UNIT (`Array.prototype.sort`'s default), never
    // `localeCompare`, which answers to the runtime's ICU default — the same
    // rule the API-report generator states for the same reason.
    expect([...found].sort()).toEqual([...WORKFLOW_KEY_STORES.map((s) => s.factory)].sort());
  });

  test("a non-conformable store says WHY, and a conformable one does not", () => {
    for (const store of WORKFLOW_KEY_STORES) {
      const exempt = store.conformance === false;
      // An exemption with no reason is an omission wearing a decision's clothes.
      expect.soft(Boolean(store.why), `${store.store} why`).toBe(exempt);
    }
  });

  test("every registered store's arm really runs the case list, in its own tier", () => {
    // The assertion the whole exercise is about. A case list constructed but
    // never handed to `workflowKeyConformance`, or handed to it from no file at
    // all, looks identical to one that runs.
    const armFiles = [...READ].filter(([, source]) => source.includes("workflowKeyConformance("));
    expect(armFiles.length).toBeGreaterThan(0);
    for (const store of WORKFLOW_KEY_STORES) {
      if (store.conformance === false) continue;
      const want = store.tier === "scenario";
      const found = armFiles.some(
        ([file, source]) =>
          /\.scenario\.test\.ts$/.test(file) === want && source.includes(`${store.factory}(`),
      );
      expect.soft(found, `${store.store} arm in the ${store.tier} tier`).toBe(true);
    }
  });

  test("the case list reaches for no implementation of its own", () => {
    // A case list that imported a store would be asserting against itself, and
    // the arm it was handed would be decoration. Comments are stripped first:
    // the modules' own docs NAME both factories at length, which is the trap
    // `store-conformance-registry.test.ts` and `check-escape-hatches.mjs` both
    // had to be taught.
    //
    // The CASE module only. The registry beside it names both factories as
    // strings by construction — that IS the registration — so it is not a case
    // list and is not scanned.
    const cases = FILES.filter(
      (f) => f.startsWith("workflow-keys-conformance-") && !isTest(f) && !f.includes("scenario"),
    );
    expect(cases.length).toBeGreaterThan(0);
    for (const file of cases) {
      const code = (READ.get(file) ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect.soft(code.split("\n").filter(isFactoryCall), file).toEqual([]);
    }
  });
});

/** `create<Something>KeyStore` — the two names `konsistent.json` pins to their module. */
function isFactory(name: string): boolean {
  return /^create[A-Z]\w*KeyStore$/.test(name);
}

/** A line that CALLS or IMPORTS one of those factories. */
function isFactoryCall(line: string): boolean {
  return /\bcreate[A-Z]\w*KeyStore\b/.test(line);
}
