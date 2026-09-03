// Copyright 2026 the AAI authors. MIT license.
/**
 * The two UNIT arms of the workflow-keys contract, plus the gate under the gate.
 *
 * - **memory**, the reference, unconditionally.
 * - **platform**, over a transport that decodes exactly what
 *   `aai-server/workflow-keys-handler.ts` decodes and then delegates every
 *   SEMANTIC to the reference store.
 *
 * The Postgres arm is `workflow-keys-conformance-postgres.scenario.test.ts`.
 *
 * ## What the MEMORY arm can and CANNOT see
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
 *
 * ## What the PLATFORM arm can and CANNOT see
 *
 * It can see everything on the guest's side of the wire: the shape of every
 * request `createPlatformKeyStore` builds, that `record` stamps a `createdAt` at
 * all (the interface takes none, so the client is what supplies it), that `lookup`
 * READS its answer rather than assuming one, and that the empty key survives the
 * route's field readers — which is a real hazard rather than a theoretical one,
 * since `requiredString` in `aai-server/_body-fields.ts` refuses `""` and a
 * withheld caller ID is exactly that.
 *
 * It CANNOT see the platform's own SQL, deliberately. A JS reimplementation of
 * those two statements would be a fourth implementation of the contract, it would
 * be the arm a reader trusts most because of its label, and it could not represent
 * a single bug the platform has actually shipped — the argument
 * `aai-server/store-conformance.ts` makes at length against `createFakeSql`. Which
 * is also why the FOURTH arm is still owed: see the entry module's header for what
 * it needs, and `aai-server/platform-workflow-keys.scenario.test.ts` for the
 * per-store suite that covers those statements in the meantime.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createMemoryKeyStore, type WorkflowKeyStore } from "./workflow-keys.ts";
import {
  WORKFLOW_KEY_STORES,
  type WorkflowKeyArm,
  workflowKeyConformance,
  workflowKeyIds,
} from "./workflow-keys-conformance.ts";
import { createPlatformKeyStore } from "./workflow-keys-platform.ts";

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
/* The platform arm, over a handler-shaped transport                          */
/* -------------------------------------------------------------------------- */

/** One request body, as JSON leaves it. */
type Body = Record<string, unknown>;

/**
 * A required non-empty string, the way `requiredString` reads one.
 *
 * The route's own reader, reproduced rather than approximated: a fake laxer than
 * the wire lets a client send a field the real route refuses.
 */
function str(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") throw new Error(`${key} is required`);
  return value;
}

/**
 * The correlation KEY, which may be empty — `keyField` in
 * `aai-server/workflow-keys-handler.ts`.
 *
 * Its own reader here for the same reason it is one there: `requiredString` above
 * refuses `""`, and the shared case "an EMPTY key is a key, not absence" is what
 * would fail if this arm used it — which is the point. A withheld caller ID is
 * the reachable source of an empty key, so the divergence would be a real one.
 */
function keyField(body: Body): string {
  const value = body.key;
  if (typeof value !== "string") throw new Error("key is required");
  return value;
}

/** A required non-negative integer — `requiredSize`. */
function size(body: Body, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

/** A required integer — `requiredInt`. */
function int(body: Body, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  return value;
}

/**
 * The route's dispatch, over a reference store.
 *
 * Both arms mirror `plan()` in `aai-server/workflow-keys-handler.ts`: the same
 * field parsing, in the same order, answering the same JSON. What it does NOT
 * mirror is the SQL below it — see this file's header for why.
 *
 * `createdAt` is READ the way the route reads it and then the reference store's
 * own insertion order decides, which is the one place this fake cannot be
 * faithful: the memory store takes no timestamp. That the client SENDS it is
 * pinned in `workflow-keys-platform.test.ts`.
 */
function serve(store: WorkflowKeyStore, method: string, body: Body): Promise<unknown> {
  switch (method) {
    case "record": {
      const runId = str(body, "runId");
      const workflow = str(body, "workflow");
      const key = keyField(body);
      int(body, "createdAt");
      // `null` rather than `undefined`: the route answers JSON, and the client
      // reads nothing off it — see `recordKey` in
      // `aai-server/platform-workflow-keys.ts`.
      return store.record(workflow, key, runId).then(() => null);
    }
    case "lookup":
      return store.lookup(str(body, "workflow"), keyField(body), size(body, "limit"));
    default:
      throw new Error("unknown workflow-keys method");
  }
}

/**
 * `createPlatformKeyStore` over the route above.
 *
 * The `fetch` seam is `PlatformEndpoint`'s own, so `platformResult` — the
 * envelope, the status check, the `{ result }` unwrapping — is production code
 * here rather than a fake's approximation.
 */
function platformKeysOver(store: WorkflowKeyStore): WorkflowKeyStore {
  const fetchFn: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    try {
      const result = await serve(store, String(body.method), body);
      return new Response(JSON.stringify({ result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err: unknown) {
      // One status, and unlike the journal's fake that is not a simplification:
      // this route has no typed refusal to preserve — `record` is idempotent and
      // `lookup` answers an empty page — so every failure really is "the store
      // did not answer", which the client propagates whatever the number was.
      return new Response(err instanceof Error ? err.message : "failed", { status: 500 });
    }
  };
  return createPlatformKeyStore({
    base: "https://platform.test/conformance",
    token: "sandbox-token",
    fetch: fetchFn,
  });
}

// ONE store across every case, for the reason the memory arm has one.
const platformStore = platformKeysOver(createMemoryKeyStore());

workflowKeyConformance({
  label: "platform (handler-shaped transport)",
  keys: () => platformStore,
  uid: workflowKeyIds("plat"),
});

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

  test("every registered factory is found, and the scan sees no more", () => {
    // **This is the test that actually catches an unregistered store here, and
    // the module scan above is not.** A/B'd: deleting the `postgres` entry from
    // `WORKFLOW_KEY_STORES` leaves the first test GREEN, because that factory
    // shares `workflow-keys.ts` with `memory` and the surviving entry still
    // registers the module — the module set is complete while the store set is
    // not. That is the price of the one-file shape, and it is why the FACTORY
    // names are compared as a set rather than the modules they sit in. Only this
    // case failed. (`platform` is the one store with a module of its own, so it
    // is the one the module scan could also catch.)
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

  test("every registered store declares at least one arm", () => {
    // The floor under the block below: every assertion there is a loop over
    // `SITES`, so a store whose `arms` list is empty satisfies all of them and
    // prints the same green — which is precisely how the platform store's missing
    // real-database arm could come to look covered.
    for (const store of WORKFLOW_KEY_STORES) {
      if (store.conformance === false) continue;
      expect.soft(store.arms.length, `${store.store} arms`).toBeGreaterThan(0);
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

/**
 * `create<Something>KeyStore` — the grammar all three factories are named by.
 *
 * `konsistent.json`'s `workflow-key-stores` convention pins the two that share
 * `workflow-keys.ts`; the platform one lives in its own module, so what keeps it
 * findable is this grammar plus the module scan above.
 */
function isFactory(name: string): boolean {
  return /^create[A-Z]\w*KeyStore$/.test(name);
}

/** A line that CALLS or IMPORTS one of those factories. */
function isFactoryCall(line: string): boolean {
  return /\bcreate[A-Z]\w*KeyStore\b/.test(line);
}

/* -------------------------------------------------------------------------- */
/* The arms, including the ones a package away                                */
/* -------------------------------------------------------------------------- */

/**
 * An ARM cannot stop existing, and one nobody declared cannot start.
 *
 * This is `journal-conformance-arms.test.ts` for the key index, and it is worth
 * having for the reason measured there: moving that package's cross-package arm
 * out of the tree left every registry gate green while deleting the only arm that
 * could see a bug in the platform's SQL. Here the same axis is live for a second
 * reason — the platform store's real-database arm is still owed, so "which files
 * answer this case list" has to be a declaration rather than a memory.
 *
 * A TEXT scan, and a test rather than a `guard-invariants` rule, for the two
 * reasons `store-conformance-registry.test.ts` gives: one arm will belong to a
 * package this one may not import, and a set comparison over declarations is not
 * a pattern a line either matches or does not.
 */
const PACKAGES = path.resolve(import.meta.dirname, "../..");

/** Every `.ts` file under `packages/`, excluding build output and dot dirs. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(path.relative(PACKAGES, full));
    }
  };
  for (const pkg of readdirSync(PACKAGES)) {
    const full = path.join(PACKAGES, pkg);
    if (statSync(full).isDirectory()) walk(full);
  }
  return out;
}

const TREE = sourceFiles();
const TREE_READ = new Map(TREE.map((f) => [f, readFileSync(path.join(PACKAGES, f), "utf-8")]));

/** Every arm site every store declares, flattened, with its store beside it. */
const SITES = WORKFLOW_KEY_STORES.filter((s) => s.conformance !== false).flatMap((store) =>
  store.arms.map((arm) => ({ ...arm, store })),
);

/**
 * Note there is no `SELF` exemption here, and the absence is deliberate rather
 * than an oversight: this file IS an arm — two of them — so it belongs in the
 * declared set, and it never names `workflowKeyConformance(` as a string literal,
 * which is the self-reference that cost `journal-conformance-arms.test.ts` a run.
 * A `SELF` list excluding a file that is legitimately declared would hide a real
 * finding rather than a false one.
 */
describe("every declared workflow-keys conformance arm", () => {
  test("really exists as a file in the tree", () => {
    // The assertion the whole block is about. An arm named in the registry and
    // absent from the tree is the state a deletion leaves behind, reported by
    // name and by store.
    const missing = SITES.filter((site) => !TREE_READ.has(site.file)).map(
      (site) => `${site.store.store}: ${site.file}`,
    );
    expect(missing).toEqual([]);
  });

  test("answers the SHARED case list, and not a private one", () => {
    // A file that still exists, still builds a store and still asserts things,
    // but no longer hands the shared list an arm, is a suite of that store's own
    // choosing wearing a conformance arm's filename.
    for (const site of SITES) {
      const source = TREE_READ.get(site.file);
      expect.soft(source, `${site.file} is readable`).toBeDefined();
      expect
        .soft(source?.includes("workflowKeyConformance("), `${site.file} invokes the case list`)
        .toBe(true);
    }
  });

  test("builds the store it claims to be an arm OF", () => {
    // Without this an arm could be re-pointed at another store and still satisfy
    // every assertion above, leaving one store with two arms and another with
    // none while the registry reads as complete.
    for (const site of SITES) {
      const source = TREE_READ.get(site.file) ?? "";
      expect
        .soft(
          source.includes(`${site.store.factory}(`),
          `${site.file} builds ${site.store.factory}`,
        )
        .toBe(true);
    }
  });

  test("sits in the TIER it declares, by the repo's naming convention", () => {
    // Membership is the `*.scenario.test.ts` infix (AGENTS.md, "Test tiers"), so
    // the declaration is checked against the filename rather than believed. A
    // scenario arm promoted to unit would otherwise claim to run unconditionally
    // while running behind `describeWithPg`.
    for (const site of SITES) {
      const isScenarioArm = /\.scenario\.test\.ts$/.test(site.file);
      expect.soft(isScenarioArm, `${site.file} tier=${site.tier}`).toBe(site.tier === "scenario");
    }
  });

  test("says what it can SEE that its siblings cannot", () => {
    // Three arms over one case list are only worth their runtime if each answers
    // something the others structurally cannot — the platform arm's own header is
    // emphatic that it cannot see the platform's SQL. An arm with nothing of its
    // own to see is one to delete, and this is where that claim is written down.
    for (const site of SITES) {
      expect.soft(site.sees.length, `${site.file} sees`).toBeGreaterThan(20);
    }
    // And distinct: two arms with the same claim means one of them is a copy.
    const seen = SITES.map((site) => site.sees);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("no file answers the case list without being registered as an arm", () => {
    // An arm somebody wrote and nobody declared is as invisible to this gate as
    // one that vanished — it runs today and its absence is unnoticed tomorrow.
    const declared = new Set(SITES.map((site) => site.file));
    const answering = TREE.filter(
      (file) =>
        /\.test\.ts$/.test(file) && (TREE_READ.get(file) ?? "").includes("workflowKeyConformance("),
    );
    // The floor under this one: a scan matching NOTHING passes the filter below
    // and prints the same green. Measured: 2 files answer the list.
    expect(answering.length).toBeGreaterThanOrEqual(2);
    expect(answering.filter((file) => !declared.has(file))).toEqual([]);
  });

  test("the arms really span two tiers, and the walk resolved something", () => {
    // The floors. Every assertion above is a loop over `SITES`, so a collapsed
    // registry satisfies all of them and prints the same green. Measured: 3 arm
    // sites over 3 stores, 2 tiers, 1 package — and the ONE package is the
    // finding rather than the shape to keep, since the arm that can see the
    // platform's own SQL has to live in `aai-server` (the entry module's header
    // says what it needs). This is the assertion that will change when it lands.
    expect(SITES.length).toBeGreaterThanOrEqual(3);
    expect(WORKFLOW_KEY_STORES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(SITES.map((site) => site.tier))).toEqual(new Set(["unit", "scenario"]));
    // The corpus floor every counting gate in this repo carries, for the reason
    // `scripts/_ratchet.mjs` gives: a narrowed walk would otherwise pass quietly.
    // Measured well over 1,700 `.ts` files under `packages/`.
    expect(TREE.length).toBeGreaterThan(800);
  });
});
