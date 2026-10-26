// Copyright 2026 the AAI authors. MIT license.
/**
 * The wire name an agent registered a tool def under, read back by the def's
 * IDENTITY.
 *
 * A tool is a FILE: its name is the file's, recorded nowhere on the def
 * (`AgentDef.tools`), and the registry's entry IS the file's default export —
 * `toolRegistry` stores the exported object itself, never a copy. A roster
 * tool's name is likewise the key on the speaker's `tools` map, and the minted
 * entry is that same object. So the one thing that can connect a def a spec
 * imported to the name the model called is the LOWERING that paired them, and
 * this is where that pairing is kept: `withTools` records each file's name as
 * a table is attached to an agent (`deployedAgent`, and so `virtual:aai/agent`,
 * go through it), `rosterToolset` records each speaker tool's as
 * `agent({ roster })` mints the roster toolset, and a reader handed the def
 * asks here.
 *
 * It is what lets an eval reader take the def rather than a string —
 * `toolResultIn(calls, placeOrder)` — and answer `InferToolOutput<typeof
 * placeOrder>`: the def carries the result type, the recording carries the
 * name, and a renamed file fails at the lookup naming the def's description
 * rather than three assertions later on a field of `undefined`.
 *
 * A `WeakMap`, so a def lowered once is never kept alive by this module. The
 * same def lowered under two names (two agents sharing one file) keeps the LAST
 * name recorded, which is the agent most recently lowered; a spec driving two
 * such agents at once lowers the one it is about to read.
 *
 * @module _testing-tool-names
 */

import type { ToolInputSchema } from "./schema.ts";
import type { ToolDef } from "./types.ts";

/** Def → the name a deployed agent registered it under. */
const NAMES = new WeakMap<object, string>();

/**
 * Record the name each def of a lowered tool table was registered under.
 * Called by `withTools` as a `tools/` table is attached to an agent, and by
 * `rosterToolset` as `agent({ roster })` mints a speaker's tools.
 */
export function recordToolNames(tools: Readonly<Record<string, ToolDef<ToolInputSchema>>>): void {
  for (const [name, def] of Object.entries(tools)) NAMES.set(def, name);
}

/**
 * The name the model calls `def` by — the `tools/<name>.ts` file it was
 * discovered from, or the key it sits under on a speaker's `tools` map.
 *
 * Only a def an agent LOWERED has one. A file tool is named when the agent is
 * imported as DEPLOYED (`virtual:aai/agent` under vitest, `deployedAgent` under
 * any other runner); a roster tool is named when `agent({ roster })` runs,
 * i.e. when `agent.ts` is imported at all. A def built inline in a spec has
 * never been lowered, so it has no name, and the throw says so.
 *
 * @throws When `def` was never lowered onto an agent.
 *
 * @example
 * ```ts
 * // file: agent.ts
 * import { agent } from "@alexkroman1/aai";
 *
 * export default agent({ name: "Orders" });
 *
 * // file: tools/place_order.ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export default tool({
 *   description: "Place the order",
 *   inputSchema: z.object({ item: z.string() }),
 *   execute: ({ item }) => ({ placed: item }),
 * });
 *
 * // file: agent.test.ts
 * import { deployedAgent, toolNameOf } from "@alexkroman1/aai/testing";
 * import { expect, test } from "vitest";
 * import authored from "./agent.ts";
 * import placeOrder from "./tools/place_order.ts";
 *
 * // Lowering the agent is what records the names; under vitest, importing it
 * // as `virtual:aai/agent` does the same.
 * deployedAgent(authored, { tools: import.meta.glob("./tools/*.ts", { eager: true }) });
 *
 * test("the model calls the tool by its file name", () => {
 *   expect(toolNameOf(placeOrder)).toBe("place_order");
 * });
 * ```
 *
 * @public
 */
export function toolNameOf(def: ToolDef<ToolInputSchema>): string {
  const name = NAMES.get(def);
  if (name === undefined) {
    throw new Error(
      `toolNameOf(def) was handed a tool no agent registered${describeDef(def)}. ` +
        "A FILE tool's name is its file name, recorded when the agent is imported as DEPLOYED — " +
        "import it as `virtual:aai/agent` under vitest, or lower it with `deployedAgent` from " +
        "@alexkroman1/aai/testing, before reading it by its def. A tool declared on a " +
        "speaker's `tools` (a roster) is named when `agent({ roster })` runs — import the " +
        "agent, then read the tool through the speaker's `tools` entry. A def built inline in " +
        "a spec has never been lowered and has no name; call its `execute` directly.",
    );
  }
  return name;
}

/**
 * How a failure names `def`: `Tool <name>` once an agent lowered it, else by
 * its description — for a helper that needs no name to do its job (the schema
 * is on the def) and must still say WHICH tool refused. `parseToolInput` and
 * `toolInputIssues` validate a def a spec built inline as readily as a lowered
 * one, so this never throws where {@link toolNameOf} would.
 */
export function describeToolForMessage(def: ToolDef<ToolInputSchema>): string {
  const name = NAMES.get(def);
  if (name !== undefined) return `Tool ${name}`;
  const described = describeDef(def);
  return described === "" ? "The tool" : `The tool${described}`;
}

/** The def's description, when it has one, so the message says WHICH tool. */
function describeDef(def: ToolDef<ToolInputSchema>): string {
  return typeof def.description === "string" && def.description !== ""
    ? ` (described as ${JSON.stringify(def.description.slice(0, 60))})`
    : "";
}
