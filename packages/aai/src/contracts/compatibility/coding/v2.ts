// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:coding` epoch 2.
 *
 * Epoch 3 changed nothing about `createCodingTools`. What moved is what it
 * RETURNS: the nine tools are `ToolDef`s, and `ToolDef` gained an optional
 * `messages` field — what the agent says while a tool runs and when it lands.
 * So this capability's report moved without its own surface moving at all,
 * and the promise this file holds is that a host wiring the workspace tools at
 * epoch 2 still compiles.
 *
 * The two things worth pinning are exactly the two a host does with the
 * result: annotate the whole set as `Record<CodingToolName, ToolDef>`, which
 * an added optional field cannot break, and hand one entry to a registry as a
 * bare `ToolDef`. A REQUIRED `messages` would have broken both.
 *
 * Coverage is per capability over the union of frozen examples, and `v1.ts`
 * already names all eight of this one's exports — so this file is free to be
 * about the transition rather than a roll-call. Its specifiers are RELATIVE,
 * like every fixture here, so it proves that epoch 2's surface compiles rather
 * than whatever the current build publishes.
 *
 * @module
 */

import type { CodingToolName } from "../../../host/coding-tools-barrel.ts";
import { createCodingTools } from "../../../host/coding-tools-barrel.ts";
import type { ToolDef } from "../../../index.ts";

/** The whole set, annotated by the key type the factory promises. */
export const workspaceTools: Record<CodingToolName, ToolDef> = createCodingTools({
  dir: "/workspace",
});

/** One entry, as a bare `ToolDef` — the shape a tool registry holds. */
export const grep: ToolDef = workspaceTools.grep;
