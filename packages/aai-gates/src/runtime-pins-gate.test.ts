// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Holds the RUNTIME MATRIX to CI — that it really runs there, on every runtime
 * it claims.
 *
 * `packages/aai-cli/src/_target-runtimes.scenario.test.ts` boots one emitted
 * deployment under `node`, `deno` and `bun` in turn. Each non-node arm is gated
 * on a binary being on PATH, so on a machine without one it SKIPS — which is
 * correct for a laptop and worthless as a gate. Four separate things have to
 * hold for it to be a gate in CI, and each one is a silent no-op when it does
 * not:
 *
 * 1. the workflow INSTALLS the runtime,
 * 2. in the job that runs the scenario tier, BEFORE the step that runs it,
 * 3. exporting `AAI_REQUIRE_<X>` so a skip becomes a hard failure,
 * 4. with that variable declared in the task's `env` in `turbo.json` — or
 *    turbo's strict env mode strips it before the task starts and (3) does
 *    nothing at all.
 *
 * Every one of those is invisible when broken: the arm skips, the job passes,
 * and the runtime nobody measured is the one the deployment breaks on. That is
 * not hypothetical here. The Deno arm shipped, on the branch that added the
 * target, as an `expect.soft(true, "deno not on PATH …")` with nothing in CI
 * installing Deno — a skip spelled as a pass, over the only assertion the
 * target rested on, green on every leg.
 *
 * **The expectation is DERIVED from the suite, not restated.** The runtimes come
 * out of that file's own `requireEnv` declarations, so a fourth runtime added to
 * the matrix fails here until the workflow installs it. A hand-kept list would
 * rot in exactly the direction that matters — a new arm silently uncovered.
 *
 * Read as TEXT (`?raw`, eager) rather than imported, and parsed without a YAML
 * library: this package may import no workspace package and carries no parser,
 * and a malformed file fails the shape assertions anyway.
 *
 * Scope is this suite's own three flags. `AAI_REQUIRE_PG`, `_STACK`,
 * `_FFMPEG`, `_MICROSANDBOX`, `_MODAL` and `_REGISTRY` belong to other suites
 * with different install shapes (docker, apt, a deliberately uninstalled
 * client) — the one thing every flag in the repo owes regardless, declaration
 * in a task's `env`, is asserted for all of them at the bottom.
 */

import { describe, expect, test } from "vitest";
import { byCodeUnit, sole, withoutYamlComments, workflowJobs } from "./_gate-support.ts";

const workflow = sole(
  import.meta.glob<string>("../../../.github/workflows/check.yml", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

const turbo = sole(
  import.meta.glob<string>("../../../turbo.json", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

const matrixSuite = sole(
  import.meta.glob<string>("../../aai-cli/src/_target-runtimes.scenario.test.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/**
 * The job that runs the scenario tier, with its argumentative comments removed.
 *
 * `withoutYamlComments` is load-bearing rather than tidy: this job argues at
 * length in comments about the very steps below — naming `setup-deno`,
 * `setup-bun` and both flags in prose — so a scan of the raw text finds the
 * EXPLANATION and passes over a step that is gone.
 */
const SCENARIO_JOB = "integration-and-scenario";
const jobSteps = (): string[] => {
  const body = withoutYamlComments(workflowJobs(workflow ?? "", "check.yml").body(SCENARIO_JOB));
  // One entry per `- ` step, in order. Splitting on the step bullet is enough
  // to ASK ABOUT ORDER, which is the whole reason this is a list rather than
  // one string: an install after the tier ran installs nothing in time.
  return body.split(/^ {6}- /m).slice(1);
};

/** The index of the first step matching `probe`, or -1. */
const stepAt = (probe: RegExp): number => jobSteps().findIndex((step) => probe.test(step));

/** One turbo task's block, from its key to the next task key at the same indent. */
const turboTask = (name: string): string => {
  const source = turbo ?? "";
  const at = source.indexOf(`    "${name}": {`);
  if (at === -1) throw new Error(`turbo.json declares no ${name} task`);
  const rest = source.slice(at + 1);
  const next = /^ {4}"[a-z:@_-]+": \{/m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
};

/**
 * The runtimes the matrix declares, as `[flag, binary]`.
 *
 * `requireEnv` is the field the suite passes to `describeWithBinary`, so this
 * reads the same declaration the skip is decided by. The binary is the flag's
 * own suffix, lowercased — which is what makes a fourth runtime need no edit
 * here.
 */
const declaredRuntimes = (): { flag: string; bin: string }[] =>
  [...(matrixSuite ?? "").matchAll(/requireEnv:\s*"(AAI_REQUIRE_([A-Z_]+))"/g)]
    .map((found) => ({ flag: found[1] as string, bin: (found[2] as string).toLowerCase() }))
    .sort((a, b) => byCodeUnit(a.flag, b.flag));

/**
 * `node` is the exception, and it is pinned here rather than assumed.
 *
 * A missing `node` could not have started vitest, so there is no skip to
 * convert into a failure and nothing for CI to install. Every OTHER runtime the
 * matrix declares owes the full chain below — which is the assertion this
 * constant exists to keep narrow: exempting a runtime has to be a decision
 * someone edits this line for.
 */
const RUNS_THE_SUITE = "AAI_REQUIRE_NODE";

const gatedRuntimes = (): { flag: string; bin: string }[] =>
  declaredRuntimes().filter((runtime) => runtime.flag !== RUNS_THE_SUITE);

/**
 * A runtime's declared FLOOR, read out of the suite, when it declares one.
 *
 * Sliced per runtime rather than scanned whole: the file declares a
 * `minVersion` twice for the same runtime (once on the gate, once on the arm),
 * and a flat scan could not say which binary either belonged to. The chunk
 * between one `bin:` and the next is that runtime's own text.
 */
const floorOf = (bin: string): string | undefined => {
  const source = matrixSuite ?? "";
  const at = source.indexOf(`bin: "${bin}"`);
  if (at === -1) return undefined;
  const rest = source.slice(at + 1);
  const next = rest.indexOf('bin: "');
  const chunk = next === -1 ? rest : rest.slice(0, next);
  return /minVersion:\s*"(\d+\.\d+\.\d+)"/.exec(chunk)?.[1];
};

/** `x.y.z` as numbers, for an ordering comparison rather than a string one. */
const asNumbers = (version: string): number[] => version.split(".").map(Number);

/** `a` is at least `b`. */
const atLeast = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
};

describe("the runtime matrix's CI pins", () => {
  test("the sources are readable and the suite declares several runtimes", () => {
    // A floor, for the reason every gate in this package carries one: every
    // assertion below is a loop over the declared runtimes, so a glob or a
    // regex that stopped matching would assert nothing and pass.
    expect(workflow, ".github/workflows/check.yml not found").toBeTypeOf("string");
    expect(turbo, "turbo.json not found").toBeTypeOf("string");
    expect(matrixSuite, "the runtime matrix suite not found").toBeTypeOf("string");
    expect(
      declaredRuntimes().map((runtime) => runtime.flag),
      "the runtime matrix no longer declares node, deno and bun",
    ).toEqual(["AAI_REQUIRE_BUN", "AAI_REQUIRE_DENO", "AAI_REQUIRE_NODE"]);
    expect(gatedRuntimes().length, "no gated runtimes parsed").toBeGreaterThanOrEqual(2);
  });

  test("the suite is IN the scenario tier, which is what CI runs", () => {
    // Tier membership is a naming convention (`*.scenario.test.ts`), so this is
    // the cheap half: a rename to `*.test.ts` would move six subprocess-booting
    // arms into the 5s unit tier, and a rename to anything else would take them
    // out of every tier at once with nothing to report it.
    const files = Object.keys(
      import.meta.glob("../../aai-cli/src/_target-runtimes.scenario.test.ts", {
        query: "?raw",
        eager: true,
      }),
    );
    expect(files, "the matrix suite is not named as a scenario-tier file").toHaveLength(1);
    expect(
      stepAt(/turbo run check:integration check:scenario/),
      "the tier is not run",
    ).toBeGreaterThanOrEqual(0);
  });

  for (const { flag, bin } of gatedRuntimes()) {
    describe(bin, () => {
      test("is declared in `check:scenario`'s env, or strict env mode strips it", () => {
        // The half that is silently inert when missing: turbo strips an
        // undeclared variable before the task starts, so the export in CI
        // would set nothing the suite can read and every arm would skip
        // itself while the job passed. In `env` rather than `passThroughEnv`
        // for the second reason too — a required run and a skipped run must
        // not share a cache entry.
        expect(
          turboTask("check:scenario"),
          `${flag} is not declared in check:scenario's env`,
        ).toContain(`"${flag}"`);
      });

      test("is INSTALLED in the job that runs the tier, pinned by SHA and version", () => {
        const install = stepAt(new RegExp(`uses: [\\w-]+/setup-${bin}@`));
        expect(install, `no setup-${bin} step in the ${SCENARIO_JOB} job`).toBeGreaterThanOrEqual(
          0,
        );
        const step = jobSteps()[install] ?? "";

        // A SHA, because a tag is mutable and this step is what decides
        // whether the arm runs at all. `.agents/dependencies.md` carries the
        // repo-wide rule; this is the same claim about the two steps a skipped
        // runtime arm depends on.
        expect(step, `the setup-${bin} step is not pinned to a 40-character SHA`).toMatch(
          new RegExp(`uses: [\\w-]+/setup-${bin}@[0-9a-f]{40}`),
        );

        // An EXACT runtime version, never a range: a moving runtime turns
        // somebody else's regression into a red required check on unrelated
        // pull requests, which is the determinism the tiers keep by carrying
        // no `retry`.
        expect(step, `the setup-${bin} step does not pin an exact ${bin} version`).toMatch(
          new RegExp(`${bin}-version: "\\d+\\.\\d+\\.\\d+"`),
        );
      });

      test("is pinned at or above the version the suite says it measured", () => {
        // The floor and the pin are two numbers in two files, and only one of
        // them is a measurement. Bun's is the worked case: below 1.4.0 the
        // emitted deployment cannot complete a WebSocket upgrade at all, so a
        // pin below the floor installs a runtime the suite then SKIPS — a
        // green job over an arm that did not run, which is this whole file's
        // subject. Not asserted equal: a newer pin is the ordinary case, and
        // requiring equality would make every upstream bump a two-file edit.
        const floor = floorOf(bin);
        if (floor === undefined) return;
        const install = stepAt(new RegExp(`uses: [\\w-]+/setup-${bin}@`));
        const pinned = new RegExp(`${bin}-version: "(\\d+\\.\\d+\\.\\d+)"`).exec(
          jobSteps()[install] ?? "",
        )?.[1];
        expect(pinned, `the setup-${bin} step pins no readable version`).toBeTypeOf("string");
        expect(
          atLeast(asNumbers(pinned ?? "0.0.0"), asNumbers(floor)),
          `CI pins ${bin} ${String(pinned)}, below the ${floor} the suite measured — every arm would skip`,
        ).toBe(true);
      });

      test("turns a SKIP into a failure, only after the binary answered", () => {
        const install = stepAt(new RegExp(`uses: [\\w-]+/setup-${bin}@`));
        const requires = stepAt(new RegExp(`${flag}=1`));
        const tier = stepAt(/turbo run check:integration check:scenario/);

        expect(
          requires,
          `nothing in the ${SCENARIO_JOB} job exports ${flag}`,
        ).toBeGreaterThanOrEqual(0);

        // The ORDER is the assertion. The action resolving is not the same
        // fact as the binary answering on PATH, so the export sits in a step
        // that runs `<bin> --version` first — and an export after the tier ran
        // would gate nothing at all.
        expect(install, `${flag} is exported before ${bin} is installed`).toBeLessThan(requires);
        expect(requires, `${flag} is exported after the scenario tier runs`).toBeLessThan(tier);
        expect(
          jobSteps()[requires] ?? "",
          `the step exporting ${flag} does not first check that ${bin} answers`,
        ).toContain(`${bin} --version`);
      });
    });
  }

  test("node is exempt DELIBERATELY, and nothing declares a flag for it", () => {
    // Pinned in both directions so the exemption stays a decision. A
    // `AAI_REQUIRE_NODE` appearing in turbo.json would be a variable nothing
    // can act on — a missing `node` could not have started vitest — and the
    // matrix says so at the declaration.
    expect(declaredRuntimes().map((r) => r.flag)).toContain(RUNS_THE_SUITE);
    expect(
      turbo,
      "AAI_REQUIRE_NODE is declared in turbo.json, where it can gate nothing",
    ).not.toContain(`"${RUNS_THE_SUITE}"`);
    expect(matrixSuite, "the node arm no longer says why it needs no require flag").toContain(
      "could not have started vitest",
    );
  });

  test("EVERY require flag the repo reads is declared in a task's env", () => {
    // The one claim that generalises past this suite, and the cheapest way to
    // catch the strict-env-mode trap for a flag nobody has written a gate for
    // yet: a `AAI_REQUIRE_*` a test consults but no task declares is a gate
    // that cannot fire, whatever its install step does.
    const sources: Record<string, string> = import.meta.glob<string>(
      ["../../*/src/**/*.scenario.test.ts", "../../*/src/**/_*test-utils.ts"],
      { query: "?raw", import: "default", eager: true },
    );
    const flags = new Set<string>();
    for (const source of Object.values(sources)) {
      for (const found of source.matchAll(/AAI_REQUIRE_[A-Z_]+/g)) flags.add(found[0]);
    }
    // A floor: an empty set would make this pass over nothing.
    expect(
      flags.size,
      "no AAI_REQUIRE_* flags found in any scenario source",
    ).toBeGreaterThanOrEqual(4);

    const undeclared = [...flags]
      .filter((flag) => flag !== RUNS_THE_SUITE)
      .filter((flag) => !(turbo ?? "").includes(`"${flag}"`))
      .sort(byCodeUnit);
    expect(
      undeclared,
      "these flags are read by a suite but declared in no turbo task, so strict env mode strips them",
    ).toEqual([]);
  });
});
