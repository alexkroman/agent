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
  revisedRecord: (
    from: EpochRecord,
    generated: { sha256: string; exports: string[] },
    added: string[],
  ) => EpochRecord;
  bumpTarget: (
    from: Contract,
    shasOf: (v: number) => Set<string>,
    sha: string,
  ) => { target: number; pointedBack: boolean };
  bumpedContract: (
    from: Contract,
    options: { target: number; retain: boolean; reason?: string },
  ) => Contract;
  branchGrowth: (
    contract: Contract,
    base: Contract | undefined,
    record: EpochRecord,
    main: EpochRecord | undefined,
  ) => { minted: number; revised: number };
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

const RULE = 2;
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
    ["revisedRecord", epochs.revisedRecord],
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

describe("G1 — a compatible change is a REVISION of the same epoch", () => {
  test("the epoch number and its rollup stay; the hash, exports and history move", () => {
    const next = epochs.revisedRecord?.(record("a"), { sha256: "b", exports: ["tool", "x"] }, [
      "x",
    ]);
    expect(next?.epoch).toBe(5);
    expect(next?.rollup).toBe("r".repeat(64));
    expect(next?.sha256).toBe("b");
    expect(next?.exports).toEqual(["tool", "x"]);
    expect(next?.revision).toBe(1);
    expect(next?.revisions?.map((r) => [r.revision, r.sha256])).toEqual([
      [0, "a"],
      [1, "b"],
    ]);
    expect(next?.revisions?.at(-1)?.reason).toBe("additive (checked): +x");
  });

  test("a second revision counted from MAIN's record replaces this branch's, not stacks", () => {
    // `writeRevision` passes the merge-base's record as `from`; the result is
    // revision 1 again, whatever the working tree already said.
    const onMain = record("a");
    const first = epochs.revisedRecord?.(onMain, { sha256: "b", exports: ["tool"] }, []);
    const second = epochs.revisedRecord?.(onMain, { sha256: "c", exports: ["tool"] }, []);
    expect(first?.revision).toBe(1);
    expect(second?.revision).toBe(1);
    expect(second?.revisions?.map((r) => r.sha256)).toEqual(["a", "c"]);
  });

  test("every revision's hash counts as the epoch's, under this rule only", () => {
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

  test("a second epoch or revision minted on one branch is counted", () => {
    const base: Contract = { current: 5, supported: [5], dropped: {} };
    const twice: Contract = { current: 7, supported: [5, 6, 7], dropped: {} };
    expect(epochs.branchGrowth?.(twice, base, record("x"), undefined).minted).toBe(2);
    const once: Contract = { current: 6, supported: [5, 6], dropped: {} };
    expect(epochs.branchGrowth?.(once, base, record("x"), undefined).minted).toBe(1);
    const stacked = epochs.branchGrowth?.(
      base,
      base,
      record("x", { revision: 3 }),
      record("y", { revision: 1 }),
    );
    expect(stacked?.revised).toBe(2);
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

  test("the CLI refuses --bump, and --update skips, while a capability is blocked", () => {
    expect(cliSource).toMatch(
      /ownershipBlockers\(pkg, ownershipFindings\(pkg, reports\), capability\)/,
    );
    expect(cliSource).toMatch(/refusing to bump/);
    expect(mintSource).toMatch(
      /const blockers = blockersOf\(capability\);\s+if \(blockers\.length > 0\)/,
    );
  });
});
