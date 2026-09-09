// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:coding` epoch 1.
 *
 * Epoch 2 is COLLATERAL, and this file is the evidence that collateral is all
 * it was. Nothing in `createCodingTools`' own signature moved; what moved is
 * the `ToolDef` it hands back, which gained an optional `onError` — and
 * `Message`, reachable through the tool context those bodies run in, which
 * gained optional `toolName` and `toolCallId`. Both are additive, so a host
 * that stores the registry in a `Record<CodingToolName, ToolDef>`, spreads it
 * into `agent({ tools })`, or picks one entry out to re-export as its own
 * `tools/read_file.ts` still compiles — which is the whole of what a host does
 * with this and the whole of what the front half below exercises.
 *
 * The three seams are here for the same reason: `validate`, `afterWrite` and
 * `env` are called with arguments the HOST's own code has to declare, so their
 * parameter and return types are the part of this contract a workspace nobody
 * rebuilt would break on.
 *
 * That is the whole promise — a widening of the value returned, and nothing on
 * the way in. If a later epoch renames a member of `CodingToolName`, narrows
 * `only`, or obliges a host to supply a seam it may currently omit, this file
 * reddens, which is the signal to DROP the epoch rather than to edit the
 * example.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **It names every one of epoch 1's 8 exports.** The gate requires it
 * (`api-contracts-gate.test.ts`) and the reason is worth understanding: a
 * fixture that names one signature freezes one signature, while every other
 * name in the epoch compiles because nothing mentions it. So the back half of
 * this file is a roll-call, and the front half is the part written to be read.
 *
 * **Its specifiers are RELATIVE.** The same gate insists, and rightly:
 * importing the package by name would resolve through its own `exports` map to
 * whatever the current build publishes, so the fixture would prove the CURRENT
 * surface compiles rather than that epoch 1's does.
 *
 * @module
 */

import type { CodingToolName, CodingToolsOptions } from "../../../host/coding-tools-barrel.ts";
import {
  BASH_TIMEOUT_MAX_MS,
  BASH_TIMEOUT_MS,
  CODING_TOOL_DESCRIPTIONS,
  createCodingTools,
  GLOB_LIMIT,
  READ_LIMIT,
} from "../../../host/coding-tools-barrel.ts";
import type { ToolDef } from "../../../index.ts";

/**
 * A host naming a directory and filling the three seams — the whole of the way
 * in.
 *
 * The two overrides quote the limits from the constants rather than restating
 * the numbers, which is what those constants are published FOR: a description
 * naming a different figure than the code enforces is worse than one naming
 * none.
 */
const options: CodingToolsOptions = {
  dir: "/workspace",
  env: { ...process.env, CI: "1" },
  validate: async (rel, content) =>
    rel.endsWith(".ts") && content.includes("debugger")
      ? "Remove the `debugger` statement before writing this file."
      : undefined,
  afterWrite: async (rel) =>
    rel === "package.json" ? "Dependencies changed — reinstall." : undefined,
  descriptions: {
    read_file: `${CODING_TOOL_DESCRIPTIONS.read_file} At most ${READ_LIMIT} lines.`,
    glob: `${CODING_TOOL_DESCRIPTIONS.glob} At most ${GLOB_LIMIT} matches.`,
    bash: `Run a command. It is killed after ${BASH_TIMEOUT_MS}ms, and may ask for at most ${BASH_TIMEOUT_MAX_MS}ms.`,
  },
};

/** The whole set, keyed by the names the model calls. */
export const workspaceTools: Record<CodingToolName, ToolDef> = createCodingTools(options);

/**
 * A NARROWED set: `only` is what makes the key type follow the argument, so a
 * read-only agent's registry does not claim to hold a `write_file`.
 */
export const readOnlyTools = createCodingTools({
  dir: "/workspace",
  only: ["list_files", "read_file", "grep"],
});

/** One entry pulled out the way a template's `tools/read_file.ts` pulls it. */
export const readFile: ToolDef = readOnlyTools.read_file;

// ── The rest of epoch 1's promised surface.
//
//    The example above pins the SHAPES the transition touched; these are the
//    names it promised and did not reach. Named here because a retained epoch
//    is a promise about all of it, and a fixture that names one signature
//    freezes one signature (`api-contracts-gate.test.ts`).

export type Epoch1Types = {
  codingToolName: CodingToolName;
  codingToolsOptions: CodingToolsOptions<"read_file">;
};

export const epoch1Values = [
  BASH_TIMEOUT_MAX_MS,
  BASH_TIMEOUT_MS,
  CODING_TOOL_DESCRIPTIONS,
  GLOB_LIMIT,
  READ_LIMIT,
  createCodingTools,
] as const;
