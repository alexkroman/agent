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
 * "12 capability contract(s) up to date ✓".
 *
 * So this suite reads the contract tree INDEPENDENTLY of the script and asserts
 * the epoch metadata really describes the capability roots: every name a root
 * declares has to appear in that capability's current epoch. An extraction that
 * silently went thin cannot satisfy that.
 *
 * It lives in aai-templates for the same reason `api-surface-file.test.ts` and
 * `claude-md-limit.test.ts` do: raw imports reach the sibling packages and the
 * repo root, and this package's tsconfig pulls in no node types.
 */

import { describe, expect, test } from "vitest";

// `import.meta.glob` is compiled away by Vite, so its options must be a literal
// at every call site — a shared `const raw = {…}` fails the transform.
const entrypoints: Record<string, string> = import.meta.glob("../aai/contracts/entrypoints/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const epochFiles: Record<string, string> = import.meta.glob("../aai/contracts/epochs/*/*.json", {
  query: "?raw",
  import: "default",
  eager: true,
});
const fixtures: Record<string, string> = import.meta.glob("../aai/contracts/compatibility/*/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

const tableSource: string =
  import.meta.glob("../aai/contracts/contracts.json", {
    query: "?raw",
    import: "default",
    eager: true,
  })["../aai/contracts/contracts.json"] ?? "{}";
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

const table = JSON.parse(tableSource) as Record<string, Contract>;
const capabilities = Object.keys(table).sort();

/** `../aai/contracts/entrypoints/tool.ts` -> `tool`. */
const basename = (key: string): string => (key.split("/").at(-1) ?? "").replace(/\.(ts|json)$/, "");
/** `../aai/contracts/epochs/tool/v3.json` -> `tool`. */
const parentDir = (key: string): string => key.split("/").at(-2) ?? "";

/**
 * The names one capability root selects.
 *
 * A deliberately different parse from the script's AST walk — the export clause
 * read as text — so the two agree only when the file really says what the gate
 * believes. Sharing the parser would make this suite re-run the bug.
 */
function compareNames(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

const declaredNames = (source: string): string[] =>
  [...source.matchAll(/^\s{2}(?:type\s+)?([A-Za-z_$][\w$]*),$/gm)]
    .map((match) => match[1] ?? "")
    .sort(compareNames);

const roots = Object.entries(entrypoints)
  .map(([key, source]) => ({ capability: basename(key), source, names: declaredNames(source) }))
  .sort((a, b) => a.capability.localeCompare(b.capability));

const epochs = Object.entries(epochFiles).map(([key, source]) => ({
  capability: parentDir(key),
  version: Number(basename(key).slice(1)),
  record: JSON.parse(source) as Epoch,
}));

const remedy = "See `node scripts/api-contracts.mjs`.";

describe("capability contracts", () => {
  test("the contract tree is discovered", () => {
    // A broken glob makes every assertion below vacuously pass, which is the
    // exact failure this file exists to catch one level up.
    expect(capabilities.length, "contracts.json parsed to nothing").toBeGreaterThanOrEqual(12);
    expect(roots.map((root) => root.capability)).toEqual(capabilities);
    expect(epochs.length).toBeGreaterThanOrEqual(capabilities.length);
    expect(Object.keys(fixtures).length).toBeGreaterThanOrEqual(capabilities.length);
    expect(capabilities).toContain("agent");
    expect(capabilities).toContain("tool");
    expect(capabilities).toContain("state");
  });

  test("every capability root selects names and declares nothing", () => {
    for (const root of roots) {
      expect(root.names.length, `${root.capability} selects no names`).toBeGreaterThan(0);
      // A root re-exports and does nothing else. Anything that DECLARES would
      // put the contract's shape in this file rather than in the API.
      expect(
        /^\s*(export\s+(?:const|function|class|interface|type|default)|declare)\s/m.test(
          root.source,
        ),
        `${root.capability} declares something of its own. ${remedy}`,
      ).toBe(false);
      expect(root.source, `${root.capability} re-exports from nowhere`).toMatch(/\bfrom\s+"/);
    }
  });

  test.each(roots)(
    "$capability's current epoch covers everything it selects",
    ({ capability, names }) => {
      const contract = table[capability];
      expect(contract, `${capability} has no contract entry`).toBeDefined();
      const current = epochs.find(
        (entry) => entry.capability === capability && entry.version === contract?.current,
      );
      expect(
        current,
        `${capability} has no v${contract?.current}.json — epoch metadata is immutable and must ` +
          `cover 1..current. ${remedy}`,
      ).toBeDefined();

      // The load-bearing assertion. An extraction that produced an empty or
      // truncated report cannot list the names its own root selects.
      const missing = names.filter((name) => !(current?.record.exports ?? []).includes(name));
      expect(
        missing,
        `${missing.length} name(s) selected by the ${capability} root are absent from its epoch ` +
          `metadata, starting with ${missing[0]}. Either the extraction went thin or the epoch ` +
          `is stale. ${remedy}`,
      ).toEqual([]);
    },
  );

  test.each(capabilities)("%s has immutable, well-formed epoch metadata", (capability) => {
    const contract = table[capability] as Contract;
    const mine = epochs
      .filter((entry) => entry.capability === capability)
      .sort((a, b) => a.version - b.version);
    expect(
      mine.map((entry) => entry.version),
      `${capability} must retain every epoch from 1 to ${contract.current}. ${remedy}`,
    ).toEqual(Array.from({ length: contract.current }, (_, index) => index + 1));

    for (const { version, record } of mine) {
      expect(record.capability, `v${version}.json names the wrong capability`).toBe(capability);
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

  test.each(capabilities)("%s classifies every historical epoch exactly once", (capability) => {
    const { current, supported, dropped } = table[capability] as Contract;
    expect(supported, `${capability} must support its current epoch`).toContain(current);
    for (let version = 1; version < current; version += 1) {
      const isSupported = supported.includes(version);
      const isDropped = Object.hasOwn(dropped, version);
      expect(
        isSupported !== isDropped,
        `${capability} epoch ${version} is ${isSupported ? "both" : "neither"} supported and ` +
          `dropped. ${remedy}`,
      ).toBe(true);
      if (isDropped) expect((dropped[version] ?? "").trim(), "a drop needs a reason").not.toBe("");
    }
  });

  test.each(capabilities)("%s evidences every epoch it advertises", (capability) => {
    for (const version of (table[capability] as Contract).supported) {
      const key = `../aai/contracts/compatibility/${capability}/v${version}.ts`;
      const fixture = fixtures[key];
      expect(
        fixture,
        `${key} is missing. Advertising ${capability} epoch ${version} as supported without a ` +
          `frozen example that still compiles is a claim with nothing behind it. ${remedy}`,
      ).toBeTypeOf("string");
      expect(
        (fixture ?? "").includes(FIXTURE_PLACEHOLDER),
        `${key} is still the scaffold. ${remedy}`,
      ).toBe(false);
      // A fixture that imports nothing compiles trivially and proves nothing.
      expect(fixture ?? "", `${key} imports no SDK surface`).toMatch(/^import[\s\S]*from "\.\./m);
    }
  });

  test("a dropped epoch keeps no fixture", () => {
    // Dropped MEANS "no longer compiles", and fixtures sit under the package
    // tsconfig — so a leftover one turns the classification into a red
    // `pnpm typecheck` rather than a recorded decision.
    for (const capability of capabilities) {
      for (const version of Object.keys((table[capability] as Contract).dropped)) {
        expect(
          fixtures[`../aai/contracts/compatibility/${capability}/v${version}.ts`],
          `${capability} epoch ${version} is dropped but still has an example. ${remedy}`,
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
    expect(surface["@alexkroman1/aai/testing"]).toEqual([
      "SentEvent",
      "TestToolContext",
      "createToolContext",
      "createUnusedDb",
    ]);
  });
});
