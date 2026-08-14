// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * The capability contracts are structurally sound, and the gate over them can
 * fail.
 *
 * `scripts/api-contracts.mjs` compares a freshly extracted report's hash against
 * a committed one. That is a comparison between two things the script derives,
 * which is the failure shape this repo keeps paying for: if the extraction
 * stopped finding anything — a capability root that no longer parses, a `dist`
 * path that stopped resolving, a fence parser that stopped matching — the gate
 * would hash nothing, agree with a committed nothing, and print
 * "21 capability contract(s) up to date ✓".
 *
 * So this suite reads the contract tree INDEPENDENTLY of the script and asserts
 * the epoch metadata really describes the capability roots: every name a root
 * declares has to appear in that capability's current epoch. An extraction that
 * silently went thin cannot satisfy that.
 *
 * It covers every package that carries contracts — `aai` and `aai-ui` — by the
 * same discovery rule the script uses (a `contracts/entrypoints/` directory),
 * because the assertions are about the SHAPE of a contract tree and a
 * second package would otherwise be unguarded by the guard.
 *
 * It lives in aai-templates for the same reason `api-surface-file.test.ts` and
 * `claude-md-limit.test.ts` do: raw imports reach the sibling packages and the
 * repo root, and this package's tsconfig pulls in no node types.
 */

import { describe, expect, test } from "vitest";

// `import.meta.glob` is compiled away by Vite, so its options must be a literal
// at every call site — a shared `const raw = {…}` fails the transform.
const entrypoints: Record<string, string> = import.meta.glob("../*/contracts/entrypoints/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const epochFiles: Record<string, string> = import.meta.glob("../*/contracts/epochs/*/*.json", {
  query: "?raw",
  import: "default",
  eager: true,
});
// Two globs because a fixture is `.tsx` wherever the package's own tsconfig
// compiles JSX — an authoring example for a component library that avoided JSX
// would demonstrate an API nobody writes.
const tsFixtures: Record<string, string> = import.meta.glob("../*/contracts/compatibility/*/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const tsxFixtures: Record<string, string> = import.meta.glob(
  "../*/contracts/compatibility/*/*.tsx",
  { query: "?raw", import: "default", eager: true },
);
const tables: Record<string, string> = import.meta.glob("../*/contracts/contracts.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

const exportsSource: string =
  import.meta.glob("../../API-EXPORTS.json", {
    query: "?raw",
    import: "default",
    eager: true,
  })["../../API-EXPORTS.json"] ?? "{}";
const checkScript: string =
  import.meta.glob("../../scripts/check.sh", {
    query: "?raw",
    import: "default",
    eager: true,
  })["../../scripts/check.sh"] ?? "";
const ciWorkflow: string =
  import.meta.glob("../../.github/workflows/check.yml", {
    query: "?raw",
    import: "default",
    eager: true,
  })["../../.github/workflows/check.yml"] ?? "";

const FIXTURE_PLACEHOLDER = "REPLACE_WITH_A_REAL_AUTHORING_EXAMPLE";

type Contract = { current: number; supported: number[]; dropped: Record<string, string> };
type Epoch = { kind: string; capability: string; epoch: number; sha256: string; exports: string[] };

const fixtures: Record<string, string> = { ...tsFixtures, ...tsxFixtures };

/** `../aai-ui/contracts/entrypoints/forms.ts` -> `aai-ui`. */
const packageOf = (key: string): string => key.split("/")[1] ?? "";
/** `../aai/contracts/entrypoints/tool.ts` -> `tool`. */
const basename = (key: string): string =>
  (key.split("/").at(-1) ?? "").replace(/\.(tsx|ts|json)$/, "");
/** `../aai/contracts/epochs/tool/v3.json` -> `tool`. */
const parentDir = (key: string): string => key.split("/").at(-2) ?? "";

function compareNames(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The names one capability root selects.
 *
 * A deliberately different parse from the script's AST walk — the export clause
 * read as text — so the two agree only when the file really says what the gate
 * believes. Sharing the parser would make this suite re-run the bug.
 *
 * It reads the CLAUSE rather than one name per line, because Biome collapses a
 * short clause onto a single line: a per-line regex found zero names in
 * `page.ts` and `theme.ts` and would have reported the healthiest possible
 * contract as empty.
 */
const declaredNames = (source: string): string[] =>
  [...source.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"/g)]
    .flatMap((match) => (match[1] ?? "").split(","))
    .map((entry) => entry.trim().replace(/^type\s+/, ""))
    .filter((entry) => /^[A-Za-z_$][\w$]*$/.test(entry))
    .sort(compareNames);

/** One contract-carrying package, assembled from the globs above. */
const packages = Object.entries(tables)
  .map(([key, source]) => {
    const pkg = packageOf(key);
    const table = JSON.parse(source) as Record<string, Contract>;
    return {
      pkg,
      table,
      capabilities: Object.keys(table).sort(compareNames),
      roots: Object.entries(entrypoints)
        .filter(([path]) => packageOf(path) === pkg)
        .map(([path, text]) => ({
          pkg,
          capability: basename(path),
          source: text,
          names: declaredNames(text),
        }))
        .sort((a, b) => compareNames(a.capability, b.capability)),
      epochs: Object.entries(epochFiles)
        .filter(([path]) => packageOf(path) === pkg)
        .map(([path, source_]) => ({
          capability: parentDir(path),
          version: Number(basename(path).slice(1)),
          record: JSON.parse(source_) as Epoch,
        })),
      /** Either extension, so a JSX-free capability may keep a `.ts` example. */
      fixture: (capability: string, version: number): string | undefined =>
        fixtures[`../${pkg}/contracts/compatibility/${capability}/v${version}.ts`] ??
        fixtures[`../${pkg}/contracts/compatibility/${capability}/v${version}.tsx`],
    };
  })
  .sort((a, b) => compareNames(a.pkg, b.pkg));

/** Every (package, capability) pair, for the per-capability cases below. */
const contracts = packages.flatMap((entry) =>
  entry.capabilities.map((capability) => ({
    ...entry,
    id: `${entry.pkg}:${capability}`,
    capability,
  })),
);
const roots = packages.flatMap((entry) =>
  entry.roots.map((root) => ({ ...entry, ...root, id: `${entry.pkg}:${root.capability}` })),
);

const remedy = "See `node scripts/api-contracts.mjs`.";

describe("capability contracts", () => {
  test("the contract tree is discovered, for every package that has one", () => {
    // A broken glob makes every assertion below vacuously pass, which is the
    // exact failure this file exists to catch one level up.
    expect(packages.map((entry) => entry.pkg)).toEqual(["aai", "aai-ui"]);
    expect(contracts.length, "no contracts parsed").toBeGreaterThanOrEqual(21);
    for (const entry of packages) {
      expect(entry.capabilities.length, `${entry.pkg} declares nothing`).toBeGreaterThan(0);
      expect(entry.roots.map((root) => root.capability)).toEqual(entry.capabilities);
      expect(entry.epochs.length).toBeGreaterThanOrEqual(entry.capabilities.length);
    }
    // The SDK's authoring surface and the client's, spot-checked by name so a
    // capability set that silently emptied out cannot pass.
    const ids = contracts.map((entry) => entry.id);
    expect(ids).toContain("aai:agent");
    expect(ids).toContain("aai:tool");
    expect(ids).toContain("aai:state");
    expect(ids).toContain("aai-ui:client");
    expect(ids).toContain("aai-ui:page");
    expect(ids).toContain("aai-ui:hooks");
    // A capability name is unique only WITHIN a package, which is why the CLI
    // takes `aai-ui:workflow`. Both of these are real and separate contracts.
    expect(ids.filter((id) => id.endsWith(":workflow"))).toEqual([
      "aai:workflow",
      "aai-ui:workflow",
    ]);
  });

  test.each(roots)("$id selects names and declares nothing", ({ id, names, source }) => {
    expect(names.length, `${id} selects no names`).toBeGreaterThan(0);
    // A root re-exports and does nothing else. Anything that DECLARES would
    // put the contract's shape in this file rather than in the API.
    expect(
      /^\s*(export\s+(?:const|function|class|interface|type|default)|declare)\s/m.test(source),
      `${id} declares something of its own. ${remedy}`,
    ).toBe(false);
    expect(source, `${id} re-exports from nowhere`).toMatch(/\bfrom\s+"/);
  });

  test.each(roots)("$id's current epoch covers everything it selects", (root) => {
    const contract = root.table[root.capability];
    expect(contract, `${root.id} has no contract entry`).toBeDefined();
    const current = root.epochs.find(
      (entry) => entry.capability === root.capability && entry.version === contract?.current,
    );
    expect(
      current,
      `${root.id} has no v${contract?.current}.json — epoch metadata is immutable and must ` +
        `cover 1..current. ${remedy}`,
    ).toBeDefined();

    // The load-bearing assertion. An extraction that produced an empty or
    // truncated report cannot list the names its own root selects.
    const missing = root.names.filter((name) => !(current?.record.exports ?? []).includes(name));
    expect(
      missing,
      `${missing.length} name(s) selected by the ${root.id} root are absent from its epoch ` +
        `metadata, starting with ${missing[0]}. Either the extraction went thin or the epoch ` +
        `is stale. ${remedy}`,
    ).toEqual([]);
  });

  test.each(contracts)("$id has immutable, well-formed epoch metadata", (entry) => {
    const contract = entry.table[entry.capability] as Contract;
    const mine = entry.epochs
      .filter((record) => record.capability === entry.capability)
      .sort((a, b) => a.version - b.version);
    expect(
      mine.map((record) => record.version),
      `${entry.id} must retain every epoch from 1 to ${contract.current}. ${remedy}`,
    ).toEqual(Array.from({ length: contract.current }, (_, index) => index + 1));

    for (const { version, record } of mine) {
      expect(record.capability, `v${version}.json names the wrong capability`).toBe(
        entry.capability,
      );
      expect(record.epoch, `v${version}.json names the wrong epoch`).toBe(version);
      // A hash of nothing is still a hash, so the shape is checked and the
      // coverage assertion above is what makes it mean something.
      expect(record.sha256, `v${version}.json has no usable hash`).toMatch(/^[0-9a-f]{64}$/);
      expect(record.exports.length, `v${version}.json exports nothing`).toBeGreaterThan(0);
      expect(record.exports, `v${version}.json's exports are unsorted`).toEqual(
        [...record.exports].sort(compareNames),
      );
    }
  });

  test.each(contracts)("$id classifies every historical epoch exactly once", (entry) => {
    const { current, supported, dropped } = entry.table[entry.capability] as Contract;
    expect(supported, `${entry.id} must support its current epoch`).toContain(current);
    for (let version = 1; version < current; version += 1) {
      const isSupported = supported.includes(version);
      const isDropped = Object.hasOwn(dropped, version);
      expect(
        isSupported !== isDropped,
        `${entry.id} epoch ${version} is ${isSupported ? "both" : "neither"} supported and ` +
          `dropped. ${remedy}`,
      ).toBe(true);
      if (isDropped) expect((dropped[version] ?? "").trim(), "a drop needs a reason").not.toBe("");
    }
  });

  test.each(contracts)("$id evidences every epoch it advertises", (entry) => {
    for (const version of (entry.table[entry.capability] as Contract).supported) {
      const where = `${entry.pkg}/contracts/compatibility/${entry.capability}/v${version}`;
      const fixture = entry.fixture(entry.capability, version);
      expect(
        fixture,
        `${where} is missing. Advertising ${entry.id} epoch ${version} as supported without a ` +
          `frozen example that still compiles is a claim with nothing behind it. ${remedy}`,
      ).toBeTypeOf("string");
      expect(
        (fixture ?? "").includes(FIXTURE_PLACEHOLDER),
        `${where} is still the scaffold. ${remedy}`,
      ).toBe(false);
      // A fixture that imports nothing compiles trivially and proves nothing.
      expect(fixture ?? "", `${where} imports no published surface`).toMatch(
        /^import[\s\S]*from "\.\./m,
      );
    }
  });

  test("a dropped epoch keeps no fixture", () => {
    // Dropped MEANS "no longer compiles", and fixtures sit under the package
    // tsconfig — so a leftover one turns the classification into a red
    // `pnpm typecheck` rather than a recorded decision.
    for (const entry of contracts) {
      for (const version of Object.keys((entry.table[entry.capability] as Contract).dropped)) {
        expect(
          entry.fixture(entry.capability, Number(version)),
          `${entry.id} epoch ${version} is dropped but still has an example. ${remedy}`,
        ).toBeUndefined();
      }
    }
  });

  test("the gate is wired into both check.sh and CI", () => {
    // It lived only in check.sh for the ratchets, and `git push --no-verify`
    // skipped every one of them. Both, or neither is enforcement.
    expect(checkScript, "scripts/check.sh does not run check:api-contracts").toContain(
      "check:api-contracts",
    );
    expect(ciWorkflow, ".github/workflows/check.yml does not run check:api-contracts").toContain(
      "check:api-contracts",
    );
    // Ordering matters: the contracts read the authoring surface out of the
    // committed API reports, so a stale report would be believed.
    for (const [label, source] of [
      ["scripts/check.sh", checkScript],
      [".github/workflows/check.yml", ciWorkflow],
    ] as const) {
      expect(
        source.indexOf("check:api-report"),
        `${label} must run check:api-report before check:api-contracts`,
      ).toBeLessThan(source.indexOf("check:api-contracts"));
    }
  });
});

describe("API-EXPORTS.json", () => {
  const surface = JSON.parse(exportsSource) as Record<string, string[]>;

  test("it names every published entry point, sorted", () => {
    const specifiers = Object.keys(surface);
    expect(specifiers.length, "API-EXPORTS.json parsed to nothing").toBeGreaterThanOrEqual(20);
    expect(specifiers).toContain("@alexkroman1/aai");
    expect(specifiers).toContain("@alexkroman1/aai-ui");
    expect(specifiers).toContain("@alexkroman1/aai-cli/typecheck");
    for (const [specifier, names] of Object.entries(surface)) {
      expect(names.length, `${specifier} exports nothing`).toBeGreaterThan(0);
      expect(names, `${specifier} is unsorted`).toEqual([...names].sort(compareNames));
      expect(new Set(names).size, `${specifier} repeats a name`).toBe(names.length);
    }
  });

  test("it carries only exported names, never forgotten ones", () => {
    // The reports include types a public signature mentions but does not export
    // (`includeForgottenExports`). Those are reviewable in the report and must
    // NOT appear here, or the list stops meaning "what a consumer can import".
    // `Db` is exported from the root and merely referenced by `/testing`.
    expect(surface["@alexkroman1/aai"]).toContain("Db");
    expect(surface["@alexkroman1/aai/testing"]).not.toContain("Db");
    // Same for `WorkflowClient`, which `createStubWorkflows` takes and returns.
    expect(surface["@alexkroman1/aai"]).toContain("WorkflowClient");
    expect(surface["@alexkroman1/aai/testing"]).not.toContain("WorkflowClient");
    // …and for `GenerateFn`, `ToolDef` and `WorkflowRunSnapshot`, which the
    // fakes added in epoch 9 take and return.
    for (const forgotten of ["GenerateFn", "ToolDef", "WorkflowRunSnapshot"]) {
      expect(surface["@alexkroman1/aai"]).toContain(forgotten);
      expect(surface["@alexkroman1/aai/testing"]).not.toContain(forgotten);
    }
    // `ToolModules` is `withDiscoveredTools`'s parameter and lives on
    // `/manifest`, which is not an authoring subpath at all — so it is forgotten
    // HERE and absent from the root too, which is the intended shape: the value a
    // caller passes is an `import.meta.glob` result, not something to name.
    expect(surface["@alexkroman1/aai/testing"]).not.toContain("ToolModules");
    expect(surface["@alexkroman1/aai/testing"]).toEqual([
      "RunSnapshotOverrides",
      "SentEvent",
      "StubGateway",
      "StubGatewayCall",
      "StubGatewayOptions",
      "StubGenerate",
      "StubGenerateCall",
      "StubGenerateReply",
      "StubGenerateRoute",
      "StubStepFetch",
      "StubStepRequest",
      "StubUpload",
      "TestToolContext",
      "ToolBearingAgent",
      "createProgressStream",
      "createRunSnapshot",
      "createStubWorkflows",
      "createToolContext",
      "createUnusedDb",
      "runTool",
      "stubGateway",
      "stubGenerate",
      "stubStepFetch",
      "stubUploads",
      "toolOf",
      "withDiscoveredTools",
    ]);
    // The vitest half is one name: the installation of the fake above it. That
    // is the whole reason it is a subpath rather than part of `/testing` — see
    // `sdk/testing-vitest.ts`.
    expect(surface["@alexkroman1/aai/testing/vitest"]).toEqual(["installStubGateway"]);
  });
});
