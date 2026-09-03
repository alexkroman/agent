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
import { byCodeUnit, GATE_WIRING, repoPathOf, sole } from "./_gate-support.ts";

// `import.meta.glob` is compiled away by Vite, so its options must be a literal
// at every call site — a shared `const raw = {…}` fails the transform.
const entrypoints: Record<string, string> = import.meta.glob(
  "../../*/src/contracts/entrypoints/*.ts",
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
);
const epochFiles: Record<string, string> = import.meta.glob(
  "../../*/src/contracts/epochs/*/*.json",
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
);
// Two globs because a fixture is `.tsx` wherever the package's own tsconfig
// compiles JSX — an authoring example for a component library that avoided JSX
// would demonstrate an API nobody writes.
const tsFixtures: Record<string, string> = import.meta.glob(
  "../../*/src/contracts/compatibility/*/*.ts",
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
);
const tsxFixtures: Record<string, string> = import.meta.glob(
  "../../*/src/contracts/compatibility/*/*.tsx",
  { query: "?raw", import: "default", eager: true },
);
const tables: Record<string, string> = import.meta.glob("../../*/src/contracts/contracts.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * The names a retained epoch promised that no frozen example imports, with a
 * reason each.
 *
 * A DENY-list, so a new fixture defaults into being checked, and a ratchet: an
 * entry may be deleted and none may be added — the spec below fails on an entry
 * whose name IS covered, because an exemption nobody counts is how a gate
 * narrows with no diff saying so.
 */
const coverageDenylistSource: string =
  sole(
    import.meta.glob("../../../scripts/api-contracts-coverage-denylist.json", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ) ?? "";

const exportsSource: string =
  sole(
    import.meta.glob("../../../API-EXPORTS.json", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ) ?? "{}";
// The RUNNER comes from the shared wiring block — the same sources every gate
// spec here reads. `?? ""` keeps a source that stopped resolving visible as an
// empty search, which the assertions below then fail on.
const checkScript: string = GATE_WIRING["scripts/check.mjs"] ?? "";

const FIXTURE_PLACEHOLDER = "REPLACE_WITH_A_REAL_AUTHORING_EXAMPLE";

type Contract = { current: number; supported: number[]; dropped: Record<string, string> };
type Epoch = { kind: string; capability: string; epoch: number; sha256: string; exports: string[] };

const fixtures: Record<string, string> = { ...tsFixtures, ...tsxFixtures };

/** `../../aai-ui/src/contracts/entrypoints/forms.ts` -> `aai-ui`. */
// Through `repoPathOf` rather than a fixed segment index: the index was 1
// while every glob here started `../`, and the `src/` move made them start
// `../../` — which silently reported every capability as `..:<name>`.
const packageOf = (key: string): string => repoPathOf(key).split("/")[1] ?? "";
/** `../aai/contracts/entrypoints/tool.ts` -> `tool`. */
const basename = (key: string): string =>
  (key.split("/").at(-1) ?? "").replace(/\.(tsx|ts|json)$/, "");
/** `../aai/contracts/epochs/tool/v3.json` -> `tool`. */
const parentDir = (key: string): string => key.split("/").at(-2) ?? "";

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
    .sort(byCodeUnit);

/**
 * The names one frozen example IMPORTS from its own package's surface.
 *
 * "Names it" is read off the import CLAUSE rather than by searching the source,
 * and the two are not close: every fixture discusses its surface at length, so a
 * word scan scores prose. `telephony/v1.ts` mentions `twilioCodec`, `telnyxCodec`
 * and `startTelephonySession` in its doc comment and imports none of them —
 * measured, a substring scan called that fixture 8 of 13 covered where its import
 * clause says 5, and one of the three it invented is the very name that file's own
 * epoch note says the transition moved through.
 *
 * An import is equivalent to a USE here, which is what makes the cheap parse
 * sound: `noUnusedImports` (biome.json) and `noUnusedLocals` (the root tsconfig)
 * both reject an imported name nothing reads, so a fixture cannot pad its score
 * with an import list. And the specifier must start with `..` — the same fact the
 * "imports no published surface" check already requires — so a name that arrived
 * from `zod` or `@alexkroman1/aai` can never be mistaken for the capability's own.
 *
 * A renamed import counts under its ORIGINAL name, which is the one the epoch
 * promised. What it still misses is a name reachable without being named: an
 * inferred type, or a member read off a value imported under another name. That
 * is the cheap error in the safe direction — it over-reports, and the remedy for
 * an over-report is an import the two unused-name rules then keep honest.
 */
const importedFromSurface = (source: string): string[] =>
  [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"(\.\.[^"]*)"/g)]
    .flatMap((match) => (match[1] ?? "").split(","))
    .map(
      (entry) =>
        entry
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0] ?? "",
    )
    .filter((entry) => /^[A-Za-z_$][\w$]*$/.test(entry))
    .sort(byCodeUnit);

/** One contract-carrying package, assembled from the globs above. */
const packages = Object.entries(tables)
  .map(([key, source]) => {
    const pkg = packageOf(key);
    const table = JSON.parse(source) as Record<string, Contract>;
    return {
      pkg,
      table,
      capabilities: Object.keys(table).sort(byCodeUnit),
      roots: Object.entries(entrypoints)
        .filter(([path]) => packageOf(path) === pkg)
        .map(([path, text]) => ({
          pkg,
          capability: basename(path),
          source: text,
          names: declaredNames(text),
        }))
        .sort((a, b) => byCodeUnit(a.capability, b.capability)),
      epochs: Object.entries(epochFiles)
        .filter(([path]) => packageOf(path) === pkg)
        .map(([path, source_]) => ({
          capability: parentDir(path),
          version: Number(basename(path).slice(1)),
          record: JSON.parse(source_) as Epoch,
        })),
      /** Either extension, so a JSX-free capability may keep a `.ts` example. */
      fixture: (capability: string, version: number): string | undefined =>
        fixtures[`../../${pkg}/src/contracts/compatibility/${capability}/v${version}.ts`] ??
        fixtures[`../../${pkg}/src/contracts/compatibility/${capability}/v${version}.tsx`],
    };
  })
  .sort((a, b) => byCodeUnit(a.pkg, b.pkg));

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

/** The deny-list, minus its `_description` prose key. */
const denials: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries(JSON.parse(coverageDenylistSource || "{}") as Record<string, unknown>).filter(
    (pair): pair is [string, Record<string, string>] => !pair[0].startsWith("_"),
  ),
);

/**
 * What each capability's frozen examples actually FREEZE.
 *
 * The three checks below on a superseded epoch's fixture — it exists, it is not
 * the scaffold, it imports from `..` — say nothing about DEGREE, and a fixture
 * importing one name out of twenty-eight satisfies all three while freezing one
 * signature. This is the fourth: a name a retained epoch promised must be named
 * by frozen code somewhere, or the promise has nothing behind it.
 *
 * **Per CAPABILITY, not per fixture, and the files argue for it themselves.**
 * Calibrated over all twelve existing examples, per-fixture completeness flags
 * nine of them — because a capability with two retained epochs SPLITS its
 * surface between them on purpose, and says so: `runtime/v3.ts` "deliberately
 * narrows" to the session-facing half and `v4.ts` is "the reason the latter is on
 * the capability"; `db/v5.ts` is "the half `v2.ts` does not reach"; `server/v6.ts`
 * the same. A rule that flags nine deliberate, documented designs is the wrong
 * rule. The union flags two, and both are real (see the deny-list, and `removed`
 * below).
 *
 * **Every name, never a percentage.** A floor cannot say WHICH name went
 * uncovered, so it absorbs the next removal silently and there is no honest
 * number to pick; a named exemption puts each gap on a reviewable line instead.
 *
 * `removed` is the one forgiveness, and it is DERIVED rather than listed: a name
 * the CURRENT epoch no longer exports cannot be imported by anything that
 * compiles, so it cannot be owed. It has one live instance and that instance is a
 * finding — `aai-runtime:db` epoch 2 promised `SweepSkip`, which is gone, and
 * epoch 4 was DROPPED for exactly that ("A consumer naming the type no longer
 * compiles, which is what makes this a drop rather than a retain"). By its own
 * standard epoch 2 is unsupportable, and it reads as supported only because
 * `v2.ts` never named the type. Left as a finding rather than an assertion,
 * because the fix is a `--bump --drop` and not a test.
 */
const coverage = contracts
  .map((entry) => {
    const { current, supported } = entry.table[entry.capability] as Contract;
    const frozen = supported.filter((version) => version !== current).sort((a, b) => a - b);
    const exportsAt = (version: number): string[] =>
      entry.epochs.find(
        (record) => record.capability === entry.capability && record.version === version,
      )?.record.exports ?? [];
    const promised = [...new Set(frozen.flatMap(exportsAt))].sort(byCodeUnit);
    const named = new Set(
      frozen.flatMap((version) =>
        importedFromSurface(entry.fixture(entry.capability, version) ?? ""),
      ),
    );
    const live = new Set(exportsAt(current));
    const exempt = denials[entry.id] ?? {};
    return {
      ...entry,
      frozen,
      promised,
      exportsAt,
      /** Promised, gone from the current surface, and therefore unfreezable. */
      removed: promised.filter((name) => !live.has(name)),
      /** Promised, still live, named by no fixture, and not exempted. */
      owed: promised.filter((name) => live.has(name) && !named.has(name) && !(name in exempt)),
      /** An exemption for a name that is covered, or was never promised. */
      stale: Object.keys(exempt)
        .filter((name) => named.has(name) || !promised.includes(name))
        .sort(byCodeUnit),
    };
  })
  .filter((entry) => entry.frozen.length > 0);

const remedy = "See `node scripts/api-contracts.mjs`.";

describe("capability contracts", () => {
  test("the contract tree is discovered, for every package that has one", () => {
    // A broken glob makes every assertion below vacuously pass, which is the
    // exact failure this file exists to catch one level up.
    expect(packages.map((entry) => entry.pkg)).toEqual(["aai", "aai-runtime", "aai-ui"]);
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
    // takes `aai-ui:workflow`. All three of these are real and separate
    // contracts — the SDK's authoring surface, the host's serving side, and the
    // browser client — and `aai-runtime` made two more names ambiguous the same
    // way (`session` with aai-ui, `uploads` with aai), which is what makes the
    // CLI's refusal to guess load-bearing rather than pedantic.
    expect(ids.filter((id) => id.endsWith(":workflow"))).toEqual([
      "aai:workflow",
      "aai-runtime:workflow",
      "aai-ui:workflow",
    ]);
    expect(ids.filter((id) => id.endsWith(":session"))).toEqual([
      "aai-runtime:session",
      "aai-ui:session",
    ]);
    expect(ids.filter((id) => id.endsWith(":uploads"))).toEqual([
      "aai:uploads",
      "aai-runtime:uploads",
    ]);
  });

  test.each(roots)("$id selects names and declares nothing", ({ id, names, source }) => {
    expect(names.length, `${id} selects no names`).toBeGreaterThan(0);
    // A root re-exports and does nothing else. Anything that DECLARES would
    // put the contract's shape in this file rather than in the API.
    //
    // `export type { … } from` is a RE-EXPORT, not a declaration, and the
    // lookahead is what tells them apart. A capability whose every name is a
    // type collapses to that form under Biome, which no root did until
    // `aai-runtime:session` and `:session-state` — so this parser reported the
    // two healthiest possible roots as declaring something of their own.
    expect(
      /^\s*(?:declare\s|export\s+(?:const|function|class|interface|default)\s|export\s+type\s+(?!\{))/m.test(
        source,
      ),
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
        [...record.exports].sort(byCodeUnit),
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

  test.each(contracts)("$id evidences every SUPERSEDED epoch it advertises", (entry) => {
    const { current, supported } = entry.table[entry.capability] as Contract;
    for (const version of supported) {
      // The current epoch owes no fixture: an example proves that source
      // written against an OLD epoch still compiles, and for the current one
      // that claim is "today's API compiles", which `pnpm typecheck` already
      // makes over the real source. See `checkFixtures` in
      // `scripts/_api-contracts-checks.mjs`.
      if (version === current) continue;
      const where = `${entry.pkg}/src/contracts/compatibility/${entry.capability}/v${version}`;
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

  test.each(coverage)("$id's frozen examples import what its epochs promised", (entry) => {
    for (const version of entry.frozen) {
      // A zero-length promise makes coverage trivially complete, which is the
      // vacuous-pass shape this whole file exists to refuse. Asserted per epoch
      // rather than over the union, because one empty record inside a healthy
      // capability is invisible in a total.
      expect(
        entry.exportsAt(version).length,
        `${entry.id} v${version}.json promises nothing, so nothing of it can be frozen`,
      ).toBeGreaterThan(0);
    }
    expect(
      entry.owed,
      `${entry.owed.length} name(s) ${entry.id} promised at epoch ${entry.frozen.join("/")} are ` +
        `imported by none of its frozen examples, starting with ${entry.owed[0]}. A fixture that ` +
        "names one signature freezes one signature — the other names compile because nothing " +
        "mentions them. Import it and use it, or record a reason in " +
        `scripts/api-contracts-coverage-denylist.json. ${remedy}`,
    ).toEqual([]);
  });

  test("no coverage exemption is dead, and the corpus it measures is not empty", () => {
    // Measured 2026-09-01: 10 fixtures across 6 capabilities, 70 distinct
    // promised names, ALL 70 imported by frozen code — nothing exempted and
    // nothing unfreezable. It read 84/75/8/1 until `aai-runtime:db` v2 and
    // `telephony` v1 were dropped as unsupportable retains, which is where the
    // last exemption and the last gone-from-the-surface name went. The floors
    // sit a third under, because a `--bump --drop` legitimately DELETES a
    // fixture and the floor must not turn a correct drop into a failure — what
    // it exists to catch is an extraction that stopped finding fixtures at all,
    // which would agree with an empty deny-list and print a checkmark.
    expect(coverage.length, "no capability has a frozen example").toBeGreaterThanOrEqual(5);
    expect(
      coverage.reduce((total, entry) => total + entry.frozen.length, 0),
      "no fixtures found",
    ).toBeGreaterThanOrEqual(8);
    expect(
      coverage.reduce((total, entry) => total + entry.promised.length, 0),
      "the frozen epochs promise almost nothing",
    ).toBeGreaterThanOrEqual(50);

    // The deny-list is a ratchet that may only shrink, so an entry that has
    // become true has to come OUT — otherwise it is unclaimed headroom the next
    // fixture inherits, exactly as `check:hatches` warns about.
    for (const entry of coverage) {
      expect(
        entry.stale,
        `scripts/api-contracts-coverage-denylist.json exempts ${entry.stale[0]} for ${entry.id}, ` +
          "which is now imported by a frozen example or promised by no retained epoch. Delete " +
          "the entry — an exemption may be removed and never added.",
      ).toEqual([]);
    }
    // A typo'd capability id exempts nothing and reads as an exemption, which is
    // the same silent widening one level up.
    const ids = new Set(coverage.map((entry) => entry.id));
    for (const id of Object.keys(denials)) {
      expect([...ids], `the deny-list names ${id}, which has no frozen example`).toContain(id);
      expect(
        Object.keys(denials[id] ?? {}).length,
        `${id}'s deny-list entry is empty`,
      ).toBeGreaterThan(0);
      for (const reason of Object.values(denials[id] ?? {})) {
        expect(reason.trim().length, `${id} has an exemption with no reason`).toBeGreaterThan(20);
      }
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

  test("the gate is wired into both check.mjs and CI", () => {
    // It lived only in the local check script for the ratchets, and `git push --no-verify`
    // skipped every one of them. Both, or neither is enforcement.
    for (const [path, text] of Object.entries(GATE_WIRING)) {
      expect(text, `${path} not found`).toBeTypeOf("string");
      expect(text, `${path} no longer references check:api-contracts`).toContain(
        "check:api-contracts",
      );
    }
    // Ordering matters: the contracts read the authoring surface out of the
    // committed API reports, so a stale report would be believed. Asserted
    // against the GATES table alone now — CI used to carry its own copy of the
    // list, and the two had to be checked separately; it runs THIS one (`node
    // scripts/check.mjs --gates ci`), in source order, so the table is the only
    // place the order can be stated. `gate-wiring.test.ts` is what holds the
    // derivation together.
    expect(
      checkScript.indexOf("check:api-report"),
      "scripts/check.mjs must run check:api-report before check:api-contracts",
    ).toBeLessThan(checkScript.indexOf("check:api-contracts"));
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
      expect(names, `${specifier} is unsorted`).toEqual([...names].sort(byCodeUnit));
      expect(new Set(names).size, `${specifier} repeats a name`).toBe(names.length);
    }
  });

  test("it carries only exported names, never forgotten ones", () => {
    // The reports include types a public signature mentions but does not export
    // (`includeForgottenExports`). Those are reviewable in the report and must
    // NOT appear here, or the list stops meaning "what a consumer can import".
    // `Db` was the original example here — exported from the root and merely
    // REFERENCED by `/testing`. It is off the root now (it went to `/internal`
    // with `ctx.db`), so it appears on neither, which is a weaker case than the
    // one this spec needs: the assertion is about a name that IS exported
    // somewhere not leaking into a subpath that only mentions it.
    expect(surface["@alexkroman1/aai"]).not.toContain("Db");
    expect(surface["@alexkroman1/aai/testing"]).not.toContain("Db");
    // `WorkflowClient` is the live case, which `createStubWorkflows` takes and
    // returns.
    expect(surface["@alexkroman1/aai"]).toContain("WorkflowClient");
    expect(surface["@alexkroman1/aai/testing"]).not.toContain("WorkflowClient");
    // …and for `GenerateFn` and `ToolDef`, which the fakes added in epoch 9 take
    // and return.
    for (const forgotten of ["GenerateFn", "ToolDef"]) {
      expect(surface["@alexkroman1/aai"]).toContain(forgotten);
      expect(surface["@alexkroman1/aai/testing"]).not.toContain(forgotten);
    }
    // `WorkflowRunSnapshot` is the same shape one subpath over: `/testing`'s
    // `createRunSnapshot` returns it, and it is EXPORTED from
    // `@alexkroman1/aai/workflow-api` rather than from the root, because what a
    // run IS is read by a page or a script and never written in an `agent.ts`.
    expect(surface["@alexkroman1/aai/workflow-api"]).toContain("WorkflowRunSnapshot");
    expect(surface["@alexkroman1/aai"]).not.toContain("WorkflowRunSnapshot");
    expect(surface["@alexkroman1/aai/testing"]).not.toContain("WorkflowRunSnapshot");
    // `ToolModules` is `ProjectFiles.tools`'s type and lives on `/manifest`,
    // which is not an authoring subpath at all — so it is forgotten HERE and
    // absent from the root too, which is the intended shape: the value a caller
    // passes is an `import.meta.glob` result, not something to name. Most specs
    // now import `virtual:aai/agent` and never see one.
    expect(surface["@alexkroman1/aai/testing"]).not.toContain("ToolModules");
    expect(surface["@alexkroman1/aai/testing"]).toEqual([
      "ProjectFiles",
      "RecordedSleep",
      "RecordedStep",
      "RunSnapshotOverrides",
      "STUB_SPEECH_PCM_BYTES",
      "SentEvent",
      "StubDelegate",
      "StubDelegateCall",
      "StubDelegateReply",
      "StubDelegateRoute",
      "StubEmitted",
      "StubGateway",
      "StubGatewayCall",
      "StubGatewayOptions",
      "StubGatewayRoute",
      "StubGenerate",
      "StubGenerateCall",
      "StubGenerateReply",
      "StubGenerateRoute",
      "StubReporter",
      "StubSpeech",
      "StubSpeechCall",
      "StubSpeechOptions",
      "StubStepAnswer",
      "StubStepFetch",
      "StubStepRequest",
      "StubTranscribe",
      "StubTranscribeCall",
      "StubTranscribeFailure",
      "StubTranscribeLeg",
      "StubTranscribeOptions",
      "StubUpload",
      "StubUploadWrite",
      "StubUploads",
      "StubUploadsOptions",
      "TestToolContext",
      "ToolBearingAgent",
      "ToolContextOverrides",
      "ToolRunner",
      "WORKFLOW_CTX_NOW",
      "WorkflowCtxOptions",
      "WorkflowCtxRecorder",
      "createProgressStream",
      "createRunSnapshot",
      "createStubWorkflows",
      "createToolContext",
      "createWorkflowCtx",
      "deployedAgent",
      "ok",
      "okPosition",
      "parseSchemaInput",
      "parseToolInput",
      "runTool",
      "schemaInputIssues",
      "stubDelegate",
      "stubGateway",
      "stubGatewayRoute",
      "stubGenerate",
      "stubReporter",
      "stubSpeech",
      "stubStepFetch",
      "stubStepInfo",
      "stubTranscribe",
      "stubUploads",
      "toolInputIssues",
      "toolOf",
      "toolRunner",
    ]);
    // The vitest half is mostly the INSTALLATION of each fake above it — the
    // same stubs with `onTestFinished(restore)` done. That is the whole reason
    // it is a subpath rather than part of `/testing`, which stays
    // framework-agnostic: importing it is what pulls the runner in.
    // `mockWorkflows` is here for the other half of the same rule — it installs
    // nothing and restores nothing, but its methods are `vi.fn`s, so `vi` IS its
    // content. See `sdk/testing-vitest.ts`.
    expect(surface["@alexkroman1/aai/testing/vitest"]).toEqual([
      "MockWorkflowsOptions",
      "installStubGateway",
      "installStubReporter",
      "installStubSpeech",
      "installStubStepFetch",
      "installStubTranscribe",
      "installStubUploads",
      "mockWorkflows",
    ]);
    // `WorkflowClient` is `mockWorkflows`'s return type and is FORGOTTEN here
    // for the same reason it is forgotten on `/testing`: it is exported from the
    // root, so a consumer names it from there.
    expect(surface["@alexkroman1/aai/testing/vitest"]).not.toContain("WorkflowClient");
  });
});
