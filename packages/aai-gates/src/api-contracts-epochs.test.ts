// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * What the capability-contract gate WRITES, and what it refuses to.
 *
 * `scripts/_api-contracts-epochs.mjs` is the pure arithmetic under `--update`
 * and `--bump` — revisions (G1), one epoch and one revision per branch, and
 * pointing `current` back at a supported epoch instead of minting a copy (G4).
 * `scripts/_api-contracts-ownership.mjs` is the one-owner rule (G2) and the
 * forgotten-export refusal (G6), with its shrink-only baseline. Both are
 * imported as real values, the same namespace-glob shape as the hash spec; the
 * CLI's USE of them is asserted on its source text, which is the only way a
 * spec here can see what a script with `node:` imports does.
 */

import { describe, expect, test } from "vitest";
import { sole } from "./_gate-support.ts";

type Revision = { revision: number; rule?: number; sha256: string; reason?: string };
type EpochRecord = {
  kind: string;
  capability: string;
  epoch: number;
  rule?: number;
  sha256: string;
  exports: string[];
  rollup?: string;
  revision?: number;
  revisions?: Revision[];
};
type Contract = { current: number; supported: number[]; dropped: Record<string, string> };
type Findings = { unowned: Map<string, string[]>; forgotten: Map<string, string[]> };
type Baseline = { unowned: string[]; forgotten: string[] };

type EpochsModule = {
  recordShas: (record: EpochRecord) => Set<string>;
  latestEpoch: (contract: Contract) => number;
  bumpTarget: (
    from: Contract,
    shasOf: (v: number) => Set<string>,
    sha: string,
  ) => { target: number; pointedBack: boolean };
  bumpedContract: (
    from: Contract,
    options: { target: number; retain: boolean; reason?: string },
  ) => Contract;
  branchGrowth: (contract: Contract, base: Contract | undefined) => { minted: number };
  isMirror: (contract: unknown) => boolean;
};
const epochs: Partial<EpochsModule> =
  sole(
    import.meta.glob<EpochsModule>("../../../scripts/_api-contracts-epochs.mjs", { eager: true }),
  ) ?? {};

type OwnershipModule = {
  classifyOwnerless: (
    reports: Map<string, { unowned: string[] }>,
    published: Set<string>,
  ) => Findings;
  againstBaseline: (
    findings: Findings,
    baseline: Baseline,
  ) => { unowned: [string, string[]][]; forgotten: [string, string[]][]; stale: string[] };
  loweredBaseline: (findings: Findings, baseline: Baseline) => Baseline;
  blockersFor: (findings: Findings, baseline: Baseline, capability: string) => string[];
};
const ownership: Partial<OwnershipModule> =
  sole(
    import.meta.glob<OwnershipModule>("../../../scripts/_api-contracts-ownership.mjs", {
      eager: true,
    }),
  ) ?? {};

const cliSource: string =
  sole(
    import.meta.glob("../../../scripts/api-contracts.mjs", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ) ?? "";
const mintSource: string =
  sole(
    import.meta.glob("../../../scripts/_api-contracts-mint.mjs", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ) ?? "";

type MirrorModule = {
  mirrorProblems: (input: {
    id: string;
    target: string;
    body: string;
    upstreamPackage: string;
    upstreamNames: Set<string>;
    baseNames?: Set<string>;
  }) => string[];
  parseMirrorTarget: (target: string) => { key: string; capability: string } | undefined;
};
const mirror: Partial<MirrorModule> =
  sole(
    import.meta.glob<MirrorModule>("../../../scripts/_api-contracts-mirror.mjs", { eager: true }),
  ) ?? {};

const RULE = 3;
const record = (sha: string, extra: Partial<EpochRecord> = {}): EpochRecord => ({
  kind: "aai-authoring-capability-contract",
  capability: "tool",
  epoch: 5,
  rule: RULE,
  sha256: sha,
  exports: ["tool"],
  rollup: "r".repeat(64),
  ...extra,
});

describe("the modules are importable", () => {
  test.each([
    ["recordShas", epochs.recordShas],
    ["isMirror", epochs.isMirror],
    ["mirrorProblems", mirror.mirrorProblems],
    ["bumpTarget", epochs.bumpTarget],
    ["bumpedContract", epochs.bumpedContract],
    ["branchGrowth", epochs.branchGrowth],
    ["classifyOwnerless", ownership.classifyOwnerless],
    ["againstBaseline", ownership.againstBaseline],
    ["loweredBaseline", ownership.loweredBaseline],
    ["blockersFor", ownership.blockersFor],
  ])("%s is exported", (name, value) => {
    expect(value, `${name} not exported`).toBeTypeOf("function");
  });
});

describe("a compatible change is not recorded; old revisions still count", () => {
  test("every revision's hash an older record carries counts as the epoch's, under this rule only", () => {
    const revised = record("c", {
      revisions: [
        { revision: 0, rule: 1, sha256: "old-rule" },
        { revision: 1, rule: RULE, sha256: "b" },
        { revision: 2, rule: RULE, sha256: "c" },
      ],
    });
    expect([...(epochs.recordShas?.(revised) ?? [])].sort()).toEqual(["b", "c"]);
    expect(epochs.recordShas?.(record("x", { rule: 1 })).size).toBe(0);
  });

  test("nothing writes a revision any more: the CLI has no --update, and --unbump instead", () => {
    expect(cliSource).not.toMatch(/update: \{ type: "boolean" \}/);
    expect(cliSource).toMatch(/unbump: \{ type: "string" \}/);
    expect(mintSource).not.toMatch(/function writeRevision\(/);
  });
});

describe("G4 — at most one epoch per branch, and back rather than a copy", () => {
  const contract: Contract = { current: 6, supported: [3, 5, 6], dropped: { 4: "gone" } };
  const shas: Record<number, string> = { 3: "three", 5: "five", 6: "six" };
  const shasOf = (v: number) => new Set([shas[v] ?? ""]);

  test("a hash equal to a SUPPORTED epoch's points current back at it", () => {
    expect(epochs.bumpTarget?.(contract, shasOf, "five")).toEqual({ target: 5, pointedBack: true });
  });

  test("a hash equal to nothing supported mints one past the LATEST epoch", () => {
    expect(epochs.bumpTarget?.(contract, shasOf, "new")).toEqual({ target: 7, pointedBack: false });
    const back: Contract = { current: 5, supported: [5, 6], dropped: {} };
    expect(epochs.latestEpoch?.(back)).toBe(6);
    expect(epochs.bumpTarget?.(back, shasOf, "new").target).toBe(7);
  });

  test("pointing back classifies the old current and un-drops nothing it should not", () => {
    const dropped = epochs.bumpedContract?.(contract, { target: 5, retain: false, reason: "back" });
    expect(dropped).toEqual({ current: 5, supported: [3, 5], dropped: { 4: "gone", 6: "back" } });
    const retained = epochs.bumpedContract?.(contract, { target: 5, retain: true });
    expect(retained).toEqual({ current: 5, supported: [3, 5, 6], dropped: { 4: "gone" } });
  });

  test("a second epoch minted on one branch is counted", () => {
    const base: Contract = { current: 5, supported: [5], dropped: {} };
    const twice: Contract = { current: 7, supported: [5, 6, 7], dropped: {} };
    expect(epochs.branchGrowth?.(twice, base).minted).toBe(2);
    const once: Contract = { current: 6, supported: [5, 6], dropped: {} };
    expect(epochs.branchGrowth?.(once, base).minted).toBe(1);
  });

  test("the CLI rewrites this branch's epochs in place rather than superseding them", () => {
    expect(mintSource).toMatch(/function discardBranchEpochs\(/);
    expect(mintSource).toMatch(/discardBranchEpochs\(pkg, capability, contract\) \?\? contract/);
  });
});

describe("G2/G6 — every hashed declaration has exactly one owner", () => {
  const reports = new Map([
    ["agent", { unowned: ["SessionEvent", "Hidden"] }],
    ["dialog", { unowned: ["SessionEvent"] }],
  ]);
  const findings = ownership.classifyOwnerless?.(reports, new Set(["SessionEvent"])) ?? {
    unowned: new Map(),
    forgotten: new Map(),
  };

  test("published-but-unowned and forgotten are told apart, with who reaches each", () => {
    expect([...findings.unowned]).toEqual([["SessionEvent", ["agent", "dialog"]]]);
    expect([...findings.forgotten]).toEqual([["Hidden", ["agent"]]]);
  });

  test("a name the baseline does not list FAILS", () => {
    const verdict = ownership.againstBaseline?.(findings, { unowned: [], forgotten: [] });
    expect(verdict?.unowned.map(([name]) => name)).toEqual(["SessionEvent"]);
    expect(verdict?.forgotten.map(([name]) => name)).toEqual(["Hidden"]);
  });

  test("a baselined name passes in EITHER list, and a gone one is reported stale", () => {
    const verdict = ownership.againstBaseline?.(findings, {
      unowned: ["Hidden", "Gone"],
      forgotten: ["SessionEvent"],
    });
    expect(verdict?.unowned).toEqual([]);
    expect(verdict?.forgotten).toEqual([]);
    expect(verdict?.stale).toEqual(["Gone"]);
  });

  test("lowering the baseline removes what is fixed and NEVER adds", () => {
    const lowered = ownership.loweredBaseline?.(findings, { unowned: ["Gone"], forgotten: [] });
    expect(lowered?.unowned).toEqual([]);
    expect(lowered?.forgotten).toEqual([]);
  });

  test("G6: a capability reaching an unbaselined ownerless type is BLOCKED, a sibling is not", () => {
    const baseline = { unowned: ["SessionEvent"], forgotten: [] };
    expect(ownership.blockersFor?.(findings, baseline, "agent")).toEqual(["Hidden"]);
    expect(ownership.blockersFor?.(findings, baseline, "dialog")).toEqual([]);
  });

  test("the CLI refuses --bump while a capability is blocked", () => {
    expect(cliSource).toMatch(
      /ownershipBlockers\(pkg, ownershipFindings\(pkg, reports\), capability\)/,
    );
    expect(cliSource).toMatch(/refusing to bump/);
  });
});

describe("a MIRROR capability is checked only for what it can get wrong itself", () => {
  const rollup = (lines: string[]) => `${lines.join("\n")}\n`;
  const PURE = rollup([
    "import { a } from '@alexkroman1/aai/testing';",
    "import { b } from '@alexkroman1/aai/testing/vitest';",
    "export { a }",
    "export { b }",
  ]);
  const input = (body: string, baseNames?: Set<string>) => {
    const base = {
      id: "aai-runtime:testing-stubs",
      target: "aai:testing",
      body,
      upstreamPackage: "@alexkroman1/aai",
      upstreamNames: new Set(["a", "b", "c"]),
    };
    return baseNames === undefined ? base : { ...base, baseNames };
  };

  test("the target is parsed as <package>:<capability>, and nothing else is", () => {
    expect(mirror.parseMirrorTarget?.("aai:testing")).toEqual({
      key: "aai",
      capability: "testing",
    });
    expect(mirror.parseMirrorTarget?.("testing")).toBeUndefined();
  });

  test("a pure re-export of upstream names, from any of upstream's subpaths, passes", () => {
    expect(mirror.mirrorProblems?.(input(PURE, new Set(["a", "b"])))).toEqual([]);
  });

  test("a declaration of its own is refused", () => {
    const own = `${PURE}\n// @public\nexport declare function extra(): void;\n`;
    expect(mirror.mirrorProblems?.(input(own)).join("\n")).toMatch(/DECLARES 1/);
  });

  test("a name upstream does not contract is refused", () => {
    const body = rollup(["import { z } from '@alexkroman1/aai/testing';", "export { z }"]);
    expect(mirror.mirrorProblems?.(input(body)).join("\n")).toMatch(/carries z/);
  });

  test("a name from another package is refused", () => {
    const body = rollup(["import { a } from '@alexkroman1/aai-ui';", "export { a }"]);
    expect(mirror.mirrorProblems?.(input(body)).join("\n")).toMatch(/somewhere other than/);
  });

  test("dropping a name upstream STILL exports is refused; one upstream dropped is not", () => {
    expect(mirror.mirrorProblems?.(input(PURE, new Set(["a", "b", "c"]))).join("\n")).toMatch(
      /no longer carries c/,
    );
    expect(mirror.mirrorProblems?.(input(PURE, new Set(["a", "b", "gone"])))).toEqual([]);
  });
});
