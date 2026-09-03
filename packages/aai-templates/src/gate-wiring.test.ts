// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Guards the wiring between `scripts/check.mjs`'s `GATES` table and the
 * `lint-typecheck-and-checks` job in `.github/workflows/check.yml`.
 *
 * `check.yml` used to carry a SECOND copy of that table, as a shell block of
 * ~20 `pnpm run check:*` lines. It drifted the only way it could: a PR deleted
 * a gate's script, its row and the spec that watched it, and left the workflow
 * line behind. `pnpm run <missing>` exits non-zero under `bash -e`, and that
 * job is in the required `ci` job's `needs` — so every push on the branch, and
 * every push to main after it merged, would have failed CI while `pnpm check`
 * stayed green locally. The gate's own spec could not catch it, because the
 * guard lived beside its subject and was deleted with it.
 *
 * The workflow now RUNS the table (`node scripts/check.mjs --gates ci`) instead
 * of restating it, and this file is the guard that cannot be deleted with its
 * subject: it lives in a package that owns neither `scripts/` nor `.github/`,
 * and it reads both sides independently of the script that runs them.
 *
 * **Every count here carries a floor**, for the reason every gate spec in this
 * package does: two empty parses agree with each other, and "every gate is
 * enforced" is vacuously true of no gates. A regex that stopped matching the
 * table's row shape would otherwise print the healthiest possible result.
 *
 * It also keeps the half that derivation does NOT cover: a step hand-added to
 * this workflow can still name a script the root manifest does not declare,
 * which is the original break in its general form.
 *
 * The parsing is deliberately not a YAML or JS parser. This package's tsconfig
 * pulls in no node types and cannot import the script under test (it reaches
 * `node:` builtins), so both sides are read as TEXT — and reading them with a
 * second, independent parser is the point rather than a compromise: a gate that
 * compared the script against itself could agree with anything.
 */

import { describe, expect, test } from "vitest";
import { byCodeUnit, GATE_WIRING, sole } from "./_gate-support.ts";

const checkScript: string = GATE_WIRING["scripts/check.mjs"] ?? "";
const manifest: string = GATE_WIRING["package.json"] ?? "";

/**
 * The workflow, globbed here rather than taken from {@link GATE_WIRING}.
 *
 * That map is "the files a gate must be NAMED in", and this change is precisely
 * why `check.yml` is no longer one of them — a gate name appearing there is now
 * the DEFECT. Reading it separately keeps the two questions apart.
 */
const workflow: string =
  sole(
    import.meta.glob<string>("../../../.github/workflows/check.yml", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ) ?? "";

/**
 * The workflow with every comment line removed.
 *
 * Load-bearing in both directions. The block that replaced the copied list
 * QUOTES the failure it prevents (`pnpm run <missing>`), so a scan of the raw
 * file would read prose as an invocation; and a gate name mentioned in a
 * comment is documentation, not a second declaration, so the
 * no-hand-restatement rule below must not fire on one.
 */
const commands: string = workflow
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

/** One row of the `GATES` table. */
interface Gate {
  readonly script: string;
  readonly phase: string;
  readonly fatal: boolean;
}

/** The source text of the `GATES` array, from its declaration to its `];`. */
function gatesBlock(): string {
  const start = checkScript.indexOf("const GATES = [");
  if (start === -1) throw new Error("scripts/check.mjs no longer declares `const GATES = [`");
  const end = checkScript.indexOf("\n];", start);
  if (end === -1) throw new Error("scripts/check.mjs's GATES table is unterminated");
  return checkScript.slice(start, end);
}

/**
 * Every row, parsed. `\s*` spans newlines, so the one-line rows and the ones
 * carrying a `why` paragraph are read by the same pattern.
 */
function tableGates(): Gate[] {
  const rows = [
    ...gatesBlock().matchAll(/script:\s*"([^"]+)",\s*phase:\s*"([^"]+)",\s*fatal:\s*(true|false)/g),
  ];
  return rows.map((row) => ({
    script: row[1] ?? "",
    phase: row[2] ?? "",
    fatal: row[3] === "true",
  }));
}

/** `GATE_SELECTIONS`, the named phase sets a caller may ask for. */
function selections(): Record<string, string[]> {
  const found = /const GATE_SELECTIONS = \{([\s\S]*?)\n\};/.exec(checkScript);
  if (found === null) throw new Error("scripts/check.mjs no longer declares GATE_SELECTIONS");
  const table: Record<string, string[]> = {};
  for (const entry of (found[1] ?? "").matchAll(/([A-Za-z][\w-]*):\s*\[([^\]]*)\]/g)) {
    table[entry[1] ?? ""] = (entry[2] ?? "")
      .split(",")
      .map((phase) => phase.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }
  return table;
}

/** The root manifest's script names. */
function rootScripts(): string[] {
  const parsed = JSON.parse(manifest) as { scripts?: Record<string, string> };
  return Object.keys(parsed.scripts ?? {});
}

/** What a root script actually runs, so a gate invoked by COMMAND is visible. */
function rootCommand(script: string): string {
  const parsed = JSON.parse(manifest) as { scripts?: Record<string, string> };
  return parsed.scripts?.[script] ?? "";
}

/**
 * Every script the workflow asks pnpm to run.
 *
 * Two spellings, because both are live: `pnpm run <name>`, and `pnpm <name>`
 * for a name carrying a colon (`pnpm test:scenario`) — no pnpm subcommand has
 * one, so the colon is what tells a script apart from `install` or `exec`.
 */
function pnpmInvocations(): string[] {
  const run = [...commands.matchAll(/pnpm run ([A-Za-z][\w:-]*)/g)];
  const bare = [...commands.matchAll(/pnpm ([a-z][\w-]*:[\w:-]+)/g)];
  return [...run, ...bare].map((hit) => hit[1] ?? "").sort(byCodeUnit);
}

/** Every `--gates <selection>` the workflow passes to the script. */
function gateSelectionsUsed(): string[] {
  return [...commands.matchAll(/scripts\/check\.mjs --gates ([\w,-]+)/g)].map(
    (hit) => hit[1] ?? "",
  );
}

/** Every flag the workflow passes to `scripts/check.mjs`. */
function flagsUsed(): string[] {
  const calls = [...commands.matchAll(/scripts\/check\.mjs ([^\n]*)/g)];
  return calls.flatMap((call) =>
    [...(call[1] ?? "").matchAll(/--([\w-]+)/g)].map((f) => f[1] ?? ""),
  );
}

/** The phases CI runs, resolved through {@link selections}. */
function ciPhases(): string[] {
  const table = selections();
  return gateSelectionsUsed().flatMap((name) => table[name] ?? name.split(","));
}

describe("the gate table and the CI job", () => {
  test("both sides parse to something", () => {
    expect(checkScript, "scripts/check.mjs did not resolve").not.toBe("");
    expect(workflow, ".github/workflows/check.yml did not resolve").not.toBe("");
    expect(manifest, "package.json did not resolve").not.toBe("");

    // FLOOR, not an exact count — rows are added and removed by ordinary
    // changes, and an exact number would make this spec the thing that fails.
    // Measured 2026-09: 18 rows (9 ratchets, 1 after-tests, 8 after-build).
    expect(tableGates().length, "no gate rows parsed out of scripts/check.mjs").toBeGreaterThan(14);

    // A row written with its fields in another order would be invisible to the
    // pattern above while still being a gate — so the structured parse has to
    // account for every `script:` key in the block, not merely find some.
    const keys = (gatesBlock().match(/script:/g) ?? []).length;
    expect(tableGates().length, "a GATES row was not parsed — check its field order").toBe(keys);
  });

  test("every gate is a script the root manifest declares", () => {
    // A row naming a script nobody can run is the mirror of the break this
    // spec exists for: there, the workflow named a script the manifest had
    // dropped; here, the table would.
    const declared = rootScripts();
    expect(declared.length, "no scripts parsed out of package.json").toBeGreaterThan(20);
    for (const gate of tableGates()) {
      expect(declared, `${gate.script} is in the GATES table but not in package.json`).toContain(
        gate.script,
      );
    }
  });

  test("CI runs the table rather than restating it", () => {
    // The derived invocation has to exist at all: without it the whole table is
    // enforced by the pre-push hook alone, which `git push --no-verify` skips.
    expect(
      gateSelectionsUsed().length,
      "check.yml no longer invokes `scripts/check.mjs --gates` — nothing in CI reads the gate table",
    ).toBeGreaterThan(0);

    // And every selection it asks for must be one the script declares, with a
    // non-empty resolution. `--gates <typo>` exits 2 in CI, which is loud; a
    // selection resolving to zero gates is the quiet failure worth a spec.
    const table = selections();
    const phases = new Set(tableGates().map((gate) => gate.phase));
    for (const name of gateSelectionsUsed()) {
      const resolved = table[name] ?? name.split(",");
      expect(resolved.length, `--gates ${name} resolves to no phase`).toBeGreaterThan(0);
      for (const phase of resolved) {
        expect(phases, `--gates ${name} names phase "${phase}", which no row declares`).toContain(
          phase,
        );
      }
    }
  });

  test("no gate is hand-restated as a workflow step", () => {
    // The rule that makes the table the only list. A gate name in a COMMENT is
    // fine (they are stripped above); an invocation is the drift coming back.
    const invoked = pnpmInvocations();
    for (const gate of tableGates()) {
      expect(
        invoked,
        `check.yml runs ${gate.script} by hand — it is a row of the GATES table, so it is already run by \`--gates ci\``,
      ).not.toContain(gate.script);
    }
  });

  test("every gate is enforced by CI, by the selection or by name", () => {
    // The claim the eight per-gate specs used to make one at a time ("my gate's
    // name appears in check.yml"), stated once and over EVERY row — including
    // the rows those specs never covered.
    //
    // Two legitimate shapes: the gate's phase is in a selection this job runs,
    // or the workflow invokes the gate's own COMMAND somewhere else.
    // `check:coverage-per-file` is the second: it belongs to the `after-tests`
    // phase and runs in the coverage matrix, per package, as
    // `node scripts/check-coverage-per-file.mjs --package …`.
    const enforced = new Set(ciPhases());
    expect(enforced.size, "no phases resolved out of check.yml").toBeGreaterThan(0);
    for (const gate of tableGates()) {
      const command = rootCommand(gate.script);
      const byCommand = command !== "" && commands.includes(command);
      expect(
        enforced.has(gate.phase) || byCommand,
        `${gate.script} (phase ${gate.phase}) is run by nothing in check.yml — CI would not enforce it`,
      ).toBe(true);
    }
  });

  test("the fatal/non-fatal distinction survives the derivation", () => {
    // `bash -e` made every gate fatal, which is what the block flattened: a
    // branch tripping three ratchets learned about one per push. The runner
    // reads the FIELD, so both kinds have to exist and it has to consult them.
    const enforced = new Set(ciPhases());
    const ciGates = tableGates().filter((gate) => enforced.has(gate.phase));
    expect(ciGates.length, "the CI selection resolves to no gates").toBeGreaterThan(10);
    expect(
      ciGates.some((gate) => gate.fatal),
      "no gate CI runs is fatal",
    ).toBe(true);
    expect(
      ciGates.some((gate) => !gate.fatal),
      "every gate CI runs is fatal — the ratchets are meant to report together",
    ).toBe(true);
    expect(checkScript, "the runner no longer reads a gate's `fatal` field").toContain(
      "if (gate.fatal)",
    );
  });

  test("the after-build chain still runs in the order it reads in", () => {
    // Ordering used to be asserted against check.yml too, by
    // api-contracts-gate.test.ts, because CI executed its own copy of the list.
    // It executes THIS list now, in source order, so the table is the only
    // place the chain can be stated — and each link reads what the one before
    // it wrote, so a stale artifact would be believed.
    const order = tableGates().map((gate) => gate.script);
    for (const [first, second] of [
      ["check:api-report", "check:api-contracts"],
      ["check:api-contracts", "check:authoring-guide"],
    ] as const) {
      expect(order, `${first} is gone from the table`).toContain(first);
      expect(order, `${second} is gone from the table`).toContain(second);
      expect(
        order.indexOf(first),
        `${first} must be declared before ${second}: the second reads what the first writes`,
      ).toBeLessThan(order.indexOf(second));
    }
    // And nothing between the table and the run may reorder them.
    expect(checkScript, "the phase filter no longer preserves source order").toMatch(
      /gatesFor = \(phase\) =>\s*\n?\s*GATES\.filter/,
    );
  });

  test("the runner refuses a selection that would check nothing", () => {
    // The non-vacuity guard on the mechanism itself, asserted by reading the
    // script rather than by running it — a run that passes cannot demonstrate
    // that it would fail. `--gates ci` printing "All 0 gate(s) … passed" over a
    // table that stopped resolving is the exact shape this repo keeps paying
    // for, and it would be a GREEN required check.
    expect(checkScript, "runSelection no longer refuses an empty selection").toMatch(
      /chosen\.length === 0/,
    );
    expect(checkScript, "an unusable selection no longer exits non-zero").toContain("USAGE_EXIT");
  });

  test("every flag check.yml passes to the script is one the script accepts", () => {
    // `parseScriptArgs` is strict, so an undeclared flag exits 2 — red CI, but
    // only once the job has run. It is the same class as the break above: two
    // files agreeing about a name, one of which moved.
    const options = /options: \{([\s\S]*?)\n {2}\},/.exec(checkScript)?.[1] ?? "";
    expect(options, "scripts/check.mjs no longer declares an options table").not.toBe("");
    const used = flagsUsed();
    expect(used.length, "check.yml passes no flags to scripts/check.mjs").toBeGreaterThan(0);
    for (const flag of used) {
      expect(options, `scripts/check.mjs does not accept --${flag}`).toMatch(
        new RegExp(`"?${flag}"?:`),
      );
    }
  });
});

describe("the workflow's own pnpm invocations", () => {
  test("every one names a script the root manifest declares", () => {
    // Deriving the gate list does not stop somebody hand-adding a step, and
    // this is the original break in its general form: `pnpm run` on a name
    // package.json does not declare exits non-zero under `bash -e`, in a job
    // the required `ci` gate depends on, with nothing local to catch it.
    const invoked = pnpmInvocations();
    // Measured 2026-09: 6 (check:knip, lint:root, check:syncpack, check:sherif,
    // check:markdown, test:scenario). A floor, because the count moves with
    // ordinary edits — but a scan finding none would pass this whole spec.
    expect(invoked.length, "no pnpm script invocations parsed out of check.yml").toBeGreaterThan(3);
    const declared = rootScripts();
    for (const script of invoked) {
      expect(
        declared,
        `check.yml runs \`pnpm run ${script}\`, which package.json does not declare`,
      ).toContain(script);
    }
  });
});
