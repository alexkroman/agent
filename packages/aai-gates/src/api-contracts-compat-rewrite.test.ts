// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * What the probe makes the two rollups AGREE on before compiling them — and
 * the break next to each agreement that it must still catch.
 *
 * `scripts/_api-contracts-compat-rewrite.mjs` rewrites both sides three ways:
 * same-named `unique symbol` brands become ONE symbol, long misuse-message
 * literal types become one marker type, and a `@sealed` type is probed
 * new-to-old only while every other position sees it unchanged. Each of those
 * turns something that used to probe as a break into a revision, which is
 * exactly the direction an over-eager rule ships a breaking change in — so,
 * as in `api-contracts-compat.test.ts`, every accepted change sits beside the
 * break it must not swallow.
 */

import { beforeAll, describe, expect, test } from "vitest";
import { sole } from "./_gate-support.ts";

type Probe = { compatible: boolean; problems: string[]; unproven: string[]; added: string[] };
const { probeCompatibility } =
  sole(
    import.meta.glob<{
      probeCompatibility: (input: { oldBody: string; newBody: string; dir: string }) => Probe;
    }>("../../../scripts/_api-contracts-compat.mjs", { eager: true }),
  ) ?? {};

const DIR = "/nonexistent-probe-root";

const probeOf = (oldBody: string, newBody: string): Probe =>
  probeCompatibility?.({ oldBody, newBody, dir: DIR }) ?? {
    compatible: false,
    problems: ["probeCompatibility-not-importable"],
    unproven: [],
    added: [],
  };

const editOf = (base: string) => (from: string, to: string) => {
  if (!base.includes(from)) throw new Error(`the fixture no longer contains ${from}`);
  return base.replace(from, to);
};

/** A result as the two fields a "compatible" assertion reads, so it can be one `toEqual`. */
const verdictOf = ({ compatible, problems }: Probe) => ({ compatible, problems });
const COMPATIBLE = { compatible: true, problems: [] };

/** Whether a result is a break with a finding NAMING `name` — the claim each rejection makes. */
const breaksNaming = (result: Probe, name: string) =>
  !result.compatible && result.problems.some((problem) => problem.startsWith(`${name}:`));

/** The shape API Extractor writes a branded, `@sealed` handle in (aai-runtime's `auth`). */
const BRANDED = `// @public @sealed
export type SessionAuth = {
    readonly [sessionAuthBrand]: true;
};

// @public
export const sessionAuthBrand: unique symbol;

// @public
export interface Handle {
    readonly [handleBrand]: true;
    id: string;
}

declare const handleBrand: unique symbol;

// @public
export function authorize(auth: SessionAuth, handle: Handle): boolean;
`;

beforeAll(() => {
  probeOf(BRANDED, BRANDED);
});

describe("a same-named `unique symbol` brand is ONE symbol on both sides", () => {
  const edit = editOf(BRANDED);

  test("an identical branded rollup is compatible", () => {
    expect(verdictOf(probeOf(BRANDED, BRANDED))).toEqual(COMPATIBLE);
  });

  test("an optional member on a branded (unsealed) type is additive", () => {
    // Before the brands were shared, `Property '[handleBrand]' is missing in
    // new.Handle` failed this in both directions.
    expect(
      verdictOf(probeOf(BRANDED, edit("    id: string;", "    id: string;\n    tag?: string;"))),
    ).toEqual(COMPATIBLE);
  });

  test("an exported brand still probes as a value, and passes", () => {
    const next = edit(
      "    readonly [sessionAuthBrand]: true;",
      "    readonly [sessionAuthBrand]: true;\n    note?: string;",
    );
    expect(verdictOf(probeOf(BRANDED, next))).toEqual(COMPATIBLE);
  });

  test("removing the brand member is a break", () => {
    const result = probeOf(BRANDED, edit("    readonly [handleBrand]: true;\n", ""));
    expect(breaksNaming(result, "Handle"), result.problems.join("\n")).toBe(true);
  });

  test("removing the brand member of a SEALED type is a break too", () => {
    const next = edit("    readonly [sessionAuthBrand]: true;\n", "    note: string;\n");
    const result = probeOf(BRANDED, next);
    expect(breaksNaming(result, "SessionAuth"), result.problems.join("\n")).toBe(true);
  });

  test("a RENAMED brand is a different symbol, and a break", () => {
    const next = BRANDED.replaceAll("handleBrand", "handleKey");
    const result = probeOf(BRANDED, next);
    expect(breaksNaming(result, "Handle"), result.problems.join("\n")).toBe(true);
  });

  test("a renamed EXPORTED brand is a removed export", () => {
    const next = BRANDED.replaceAll("sessionAuthBrand", "sessionAuthKey");
    const result = probeOf(BRANDED, next);
    expect(breaksNaming(result, "sessionAuthBrand"), result.problems.join("\n")).toBe(true);
  });
});

/**
 * A sealed handle, an unsealed input, and a function that takes the handle
 * BACK — the position that fails unless the handle is masked elsewhere.
 */
const SEALED = `// @public @sealed
export interface Runtime {
    readonly [runtimeBrand]: true;
    run(): void;
}

// @public
export const runtimeBrand: unique symbol;

// @public
export interface Options {
    name: string;
}

// @public
export function createRuntime(options: Options): Runtime;

// @public
export function connect(runtime: Runtime, options: Options): Session;

/**
 * An unexported sealed helper, reached only through an export.
 *
 * @sealed
 */
interface SessionInfo {
    id: string;
}

// @public
export type Session = {
    info: SessionInfo;
};
`;

describe("a `@sealed` type is probed like a VALUE — new-to-old only", () => {
  const edit = editOf(SEALED);

  test("a sealed interface gaining a REQUIRED member is compatible", () => {
    // Including `connect`, which takes a `Runtime` back: the author passes the
    // one `createRuntime` gave them, which is the new one.
    const next = edit("    run(): void;", "    run(): void;\n    stop(): void;");
    expect(verdictOf(probeOf(SEALED, next))).toEqual(COMPATIBLE);
  });

  test("an unexported sealed type gaining a required member is compatible", () => {
    const next = edit("    id: string;\n}", "    id: string;\n    startedAt: number;\n}");
    expect(verdictOf(probeOf(SEALED, next))).toEqual(COMPATIBLE);
  });

  test("a sealed interface LOSING a member is a break", () => {
    const next = edit("    run(): void;\n", "");
    const result = probeOf(SEALED, next);
    expect(breaksNaming(result, "Runtime"), result.problems.join("\n")).toBe(true);
  });

  test("an unexported sealed type losing a member is a break, named by it", () => {
    const next = edit("    id: string;\n}", "    key: string;\n}");
    const result = probeOf(SEALED, next);
    expect(breaksNaming(result, "SessionInfo"), result.problems.join("\n")).toBe(true);
  });

  test("a sealed member that now provides LESS is a break", () => {
    const next = edit("    id: string;\n}", "    id: string | number;\n}");
    const result = probeOf(SEALED, next);
    expect(breaksNaming(result, "SessionInfo"), result.problems.join("\n")).toBe(true);
  });

  test("an UNSEALED type gaining a required member is still a break", () => {
    const next = edit("    name: string;", "    name: string;\n    region: string;");
    const result = probeOf(SEALED, next);
    expect(breaksNaming(result, "Options"), result.problems.join("\n")).toBe(true);
  });

  test("the same change without the tag is a break — the tag is what decides", () => {
    const untagged = SEALED.replace(
      "// @public @sealed\nexport interface Runtime",
      "// @public\nexport interface Runtime",
    );
    const next = editOf(untagged)("    run(): void;", "    run(): void;\n    stop(): void;");
    const result = probeOf(untagged, next);
    expect(breaksNaming(result, "Runtime"), result.problems.join("\n")).toBe(true);
  });

  test("the tag counts on EITHER side: sealing and extending in one change", () => {
    const untagged = SEALED.replace(
      "// @public @sealed\nexport interface Runtime",
      "// @public\nexport interface Runtime",
    );
    const next = edit("    run(): void;", "    run(): void;\n    stop(): void;");
    expect(verdictOf(probeOf(untagged, next))).toEqual(COMPATIBLE);
  });

  test("a one-sided `any` in a sealed type is still unproven", () => {
    const next = edit("    run(): void;", "    run(): any;");
    const result = probeOf(SEALED, next);
    expect(result.compatible).toBe(false);
    expect(result.unproven.some((p) => p.startsWith("Runtime:"))).toBe(true);
  });
});

const MISUSE = `// @public
export type AgentParams = {
    name: string;
    tools?: InlineToolsMisuse;
    voice?: string;
    minTurnSilenceMs?: PipelineOnlyMisuse<"minTurnSilenceMs">;
};

type InlineToolsMisuse = "a tool is declared by its FILE, not here — create \`tools/<name>.ts\` with \`export default tool({ … })\`";

type PipelineOnlyMisuse<K extends string> = \`\\\`\${K}\\\` is pipeline-mode only — it has no effect on a speech-to-speech agent; remove it or remove \\\`s2s\\\`\`;

// @public
export type Mode = "fast" | "slow";
`;

describe("a misuse-message literal reads the same on both sides", () => {
  const edit = editOf(MISUSE);

  test("rewording a long string-literal misuse message is compatible", () => {
    const next = edit(
      "a tool is declared by its FILE, not here",
      "tools are declared by FILE, never inline here",
    );
    expect(verdictOf(probeOf(MISUSE, next))).toEqual(COMPATIBLE);
  });

  test("rewording a long TEMPLATE-literal misuse message is compatible", () => {
    const next = edit(
      "it has no effect on a speech-to-speech agent",
      "a speech-to-speech agent ignores it entirely",
    );
    expect(verdictOf(probeOf(MISUSE, next))).toEqual(COMPATIBLE);
  });

  test("FORBIDDING a field that accepted any string is still a break", () => {
    // Reading the message as `string`, as the hash does, would hide this one.
    const next = edit(
      "    voice?: string;",
      '    voice?: "`voice` is pipeline-mode only — an S2S agent\'s voice rides on the `s2s` descriptor itself";',
    );
    const result = probeOf(MISUSE, next);
    expect(breaksNaming(result, "AgentParams"), result.problems.join("\n")).toBe(true);
  });

  test("a SHORT literal is shape, and a changed one is still a break", () => {
    const result = probeOf(MISUSE, edit('"fast" | "slow"', '"fast" | "slower"'));
    expect(breaksNaming(result, "Mode"), result.problems.join("\n")).toBe(true);
  });

  test("a misuse field turned into a real type is still a break", () => {
    const next = edit("    tools?: InlineToolsMisuse;\n", "    tools?: string[];\n");
    const result = probeOf(MISUSE, next);
    expect(breaksNaming(result, "AgentParams"), result.problems.join("\n")).toBe(true);
  });
});
