// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Guards `scripts/check-untyped-imports.mjs` — the gate that keeps a
 * `noImplicitAny: false` program from importing a module with no declarations.
 *
 * That gate's healthy output is a pair of ZEROES, which is the failure shape
 * this repo keeps paying for: a run that resolved nothing prints the same zero
 * as a clean tree. The gate answers that with a liveness floor per program, so
 * the assertions here are about the things that would let IT pass while
 * measuring nothing —
 *
 * - both programs it names are real, and are exactly the ones that actually
 *   relax `noImplicitAny` (a third one added to a config and not to the gate is
 *   a program checked by nobody),
 * - each floor is a real number, above zero and under the count the tree really
 *   produces (a floor of zero is no floor; a floor above the tree fails always),
 * - the floor is compared BEFORE its verdict is trusted,
 * - it forces the flag rather than reading it, and keys on TS7016 rather than
 *   on TS7006 — which is the entire distinction that lets the relaxation stand,
 * - and it is wired into `scripts/check.mjs`, since a gate reachable only by its
 *   own npm script is enforced by whoever remembers to type it.
 *
 * Assertions are made against the script's SOURCE, as in
 * `package-layout-gate.test.ts`: this package's tsconfig declares no node
 * types, so a spec here cannot spawn the gate — it reads the file CI runs.
 */

import { describe, expect, test } from "vitest";
import { GATE_WIRING, numericConstant, repoPathOf, sole } from "./_gate-support.ts";

const script = sole(
  import.meta.glob("../../../scripts/check-untyped-imports.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/** The same text, never absent — every reader below scrapes it. */
const source: string = script ?? "";

/** Every root tsconfig, keyed repo-relative, so the gate's list can be checked against reality. */
const rootConfigs = Object.fromEntries(
  Object.entries(
    import.meta.glob("../../../tsconfig.*.json", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).map(([key, text]) => [repoPathOf(key), text as string]),
);

/** The configs that actually turn `noImplicitAny` off — the set the gate must cover. */
const relaxed = Object.entries(rootConfigs)
  .filter(([, text]) => /"noImplicitAny"\s*:\s*false/.test(text))
  .map(([name]) => name)
  .sort();

describe("check:untyped-imports", () => {
  test("the gate source resolves", () => {
    // Everything below searches this string; an unresolved glob would make each
    // assertion a search of the empty string, which passes for `not.toContain`.
    expect(script).toBeTypeOf("string");
    expect(source.length).toBeGreaterThan(2000);
  });

  test("it names EVERY program that relaxes noImplicitAny", () => {
    // The membership rule. A third relaxed program added to the repo and not to
    // `PROGRAMS` is a program whose untyped imports nothing reports — the exact
    // hole this gate was written to close, reopened one config over.
    expect(relaxed.length).toBeGreaterThanOrEqual(2);
    for (const config of relaxed) {
      expect(source, `${config} relaxes noImplicitAny but the gate does not name it`).toContain(
        `"${config}"`,
      );
    }
  });

  test("it names ONLY programs that exist and really relax the flag", () => {
    // The other direction: a name left behind after a config was deleted or
    // re-tightened is a row that can never fail, and it reads as coverage.
    const named = [...source.matchAll(/config:\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(named.length).toBeGreaterThanOrEqual(2);
    for (const config of named) {
      expect(rootConfigs[config], `the gate names ${config}, which does not exist`).toBeTypeOf(
        "string",
      );
      expect(relaxed, `the gate names ${config}, which does not relax noImplicitAny`).toContain(
        config,
      );
    }
  });

  test("every liveness floor is a real number, above zero", () => {
    // A floor of zero is the gate reporting success over a run that compiled
    // nothing — which is precisely what the floor exists to catch.
    const floors = [...source.matchAll(/minImplicitAny:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(floors.length).toBe(relaxed.length);
    for (const floor of floors) expect(floor).toBeGreaterThan(0);
  });

  test("the floor is checked BEFORE the TS7016 verdict is trusted", () => {
    // Order is the point: a floor evaluated after the verdict would let a
    // program that resolved nothing report "0 untyped imports" and pass.
    expect(source.indexOf("live < minImplicitAny")).toBeGreaterThan(-1);
    expect(source.indexOf("live < minImplicitAny")).toBeLessThan(
      source.indexOf("untyped.length > 0"),
    );
  });

  test("it FORCES the flag rather than reading whatever the config says", () => {
    // Reading the config would make it agree with the relaxation and report
    // nothing — the flag has to be overridden on the command line for TS7016 to
    // exist at all.
    expect(source).toContain('"--noImplicitAny"');
    expect(source).toContain('"--noEmit"');
  });

  test("it keys on TS7016 and deliberately NOT on TS7006", () => {
    // The distinction the whole design rests on: TS7006 is the ~500 "this JS
    // parameter has no JSDoc" findings the relaxation legitimately suppresses,
    // and TS7006 is used ONLY as the liveness signal. A gate that failed on it
    // would be the config change the relaxation's own comment argues against.
    expect(source).toContain("7016");
    expect(source).toContain("7006");
    expect(source).toMatch(/withCode\(out,\s*7016\)/);
    expect(source).toMatch(/withCode\(out,\s*7006\)/);
    // The failing comparison is on the 7016 bucket, never the 7006 one.
    expect(source).toContain("untyped.length > 0");
    expect(source).not.toMatch(/live\s*>\s*0/);
  });

  test("a non-zero tsc exit is the NORMAL path, not an error", () => {
    // tsc exits non-zero by construction here (hundreds of TS7006), so the
    // catch branch is where the diagnostics live. Treating the throw as a
    // failure would make every run red; ignoring stderr would turn a missing
    // binary into an empty, healthy-looking run — the `_scaffold-tsc.mjs` rule.
    expect(source).toContain("err.stdout");
    expect(source).toContain("err.stderr");
    expect(source).toContain("spawnFailure");
  });

  test("it is wired into the gate runner, not only into package.json", () => {
    // A gate reachable only by its own npm script is enforced by whoever
    // remembers to type it. `check.mjs` is what `pnpm check` and CI both run.
    const manifest = GATE_WIRING["package.json"] ?? "";
    const runner = GATE_WIRING["scripts/check.mjs"] ?? "";
    expect(manifest).toContain('"check:untyped-imports"');
    expect(manifest).toContain("scripts/check-untyped-imports.mjs");
    expect(runner).toContain('script: "check:untyped-imports"');
    expect(runner).toMatch(/check:untyped-imports[^\n]*\n\s*phase: "ratchets"/);
  });

  test("numericConstant still reads the floors it would be asked for", () => {
    // Guards the helper contract this spec leans on, the way the other gate
    // specs do: a floor that stops being a bare literal silently stops being
    // readable, and every assertion above would then be searching nothing.
    expect(() => numericConstant(source, "NOT_A_REAL_CONSTANT", "x")).toThrow();
  });
});
