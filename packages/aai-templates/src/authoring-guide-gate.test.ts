// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * `check:authoring-guide` can actually fail, and is actually run.
 *
 * The gate asserts that every contracted authoring capability is named in the
 * code of `packages/aai-templates/scaffold/CLAUDE.md` — the guide that ships
 * inside every `aai init` project and inside the `@alexkroman1/aai` tarball.
 * Its whole success output is a count, which is the shape this repo keeps
 * paying for: a capability scan that stopped finding anything, or a fence
 * parser that stopped matching, would compare an empty set against an empty
 * corpus and print a checkmark. The script carries floors for both halves; this
 * suite reads the tree independently and asserts those floors are real.
 *
 * It also pins the two things a reader has to be able to trust about the
 * result: that the guide names capabilities in CODE rather than in prose (the
 * distinction the gate turns on, since half the capability names are ordinary
 * English), and that the deny-list is a deny-list — every exemption carries a
 * reason, and nothing is exempt that the guide already documents.
 */

import { describe, expect, test } from "vitest";
import { byCodeUnit, GATE_WIRING, repoPathOf, sole } from "./_gate-support.ts";

const gateSource: string =
  sole(
    import.meta.glob("../../../scripts/check-authoring-guide.mjs", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ) ?? "";

const guide: string =
  sole(
    import.meta.glob("../scaffold/CLAUDE.md", { query: "?raw", import: "default", eager: true }),
  ) ?? "";

const epochFiles: Record<string, string> = import.meta.glob(
  "../../*/src/contracts/epochs/*/*.json",
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
);

const tables: Record<string, string> = import.meta.glob("../../*/src/contracts/contracts.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * The guide's code, extracted the same way the gate extracts it.
 *
 * Deliberately a second implementation rather than an import: this suite exists
 * to catch the gate's extractor going empty, and sharing the extractor would
 * make both halves go empty together.
 */
function guideCode(markdown: string): string[] {
  const fences = [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  const withoutFences = markdown.replace(/```[^\n]*\n[\s\S]*?```/g, "\n");
  const inline = [...withoutFences.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "");
  return [...fences, ...inline];
}

/** `<package>:<capability>` for every capability with a committed epoch. */
function committedCapabilities(): string[] {
  const found = new Set<string>();
  for (const [path, raw] of Object.entries(tables)) {
    const pkg = repoPathOf(path).split("/")[1] ?? "";
    for (const capability of Object.keys(JSON.parse(raw) as Record<string, unknown>)) {
      found.add(`${pkg}:${capability}`);
    }
  }
  return [...found].sort(byCodeUnit);
}

const spans = guideCode(guide);
const code = spans.join("\n");

describe("check:authoring-guide", () => {
  test("is wired into package.json, check.mjs and the CI check job", () => {
    for (const [file, source] of Object.entries(GATE_WIRING)) {
      expect(source, `${file} did not resolve`).toBeTypeOf("string");
      expect(source, `${file} does not run check:authoring-guide`).toContain(
        "check:authoring-guide",
      );
    }
  });

  test("carries a floor on the capability count and on the code corpus", () => {
    // Both are the "printed a checkmark over nothing" guard. Asserted by
    // reading the script's source rather than by running it, for the reason
    // every gate spec here does: a run that already passes cannot demonstrate
    // that it would fail.
    expect(gateSource).toMatch(/const MIN_CAPABILITIES = \d+;/);
    expect(gateSource).toMatch(/const MIN_CODE_SPANS = \d+;/);

    const capabilityFloor = Number(/const MIN_CAPABILITIES = (\d+);/.exec(gateSource)?.[1]);
    const spanFloor = Number(/const MIN_CODE_SPANS = (\d+);/.exec(gateSource)?.[1]);

    // Under the actuals, so an ordinary edit does not trip them, and above zero,
    // so a scan that went empty does.
    expect(capabilityFloor).toBeGreaterThan(0);
    expect(spanFloor).toBeGreaterThan(0);
    expect(committedCapabilities().length).toBeGreaterThan(capabilityFloor);
    expect(spans.length).toBeGreaterThan(spanFloor);
  });

  test("the guide really does name capabilities in CODE, not only in prose", () => {
    // The gate's central choice. If this ever failed, every capability would be
    // reported undocumented for a reason that has nothing to do with the guide.
    for (const name of ["agent", "tool", "sessionSlot", "workflow", "dialog", "procedure"]) {
      expect(code, `${name} appears in no code span of the shipped guide`).toMatch(
        new RegExp(`(^|[^A-Za-z0-9_$])${name}([^A-Za-z0-9_$]|$)`),
      );
    }
  });

  test("every exemption names a real capability and carries a reason", () => {
    const block = /const UNDOCUMENTED_CAPABILITIES = \{([\s\S]*?)\n\};/.exec(gateSource)?.[1] ?? "";
    const ids = [...block.matchAll(/"([a-z0-9-]+:[a-z0-9-]+)":/g)].map((match) => match[1]);
    // Not empty by assertion: an exemption-free gate is the goal, and this
    // suite must not be what stops it reaching zero.
    const known = new Set(committedCapabilities());
    for (const id of ids) {
      expect(known, `${id} is exempt but is not a committed capability`).toContain(id);
    }
    // A reason, not a bare `true`. The block is the reasons, so its length is
    // the cheap proxy — a one-word entry cannot reach it.
    if (ids.length > 0) expect(block.length).toBeGreaterThan(ids.length * 80);
  });

  test("the epoch export lists it reads are non-empty", () => {
    // The gate matches a capability by its epoch's export names. An epoch file
    // that parsed to `{}` would make its capability unsatisfiable, which reads
    // as a documentation failure rather than as the data problem it is.
    const empty = Object.entries(epochFiles)
      .map(([path, raw]) => [path, JSON.parse(raw) as { exports?: string[] }] as const)
      .filter(([, epoch]) => (epoch.exports ?? []).length === 0)
      .map(([path]) => path);
    expect(empty).toEqual([]);
  });
});
