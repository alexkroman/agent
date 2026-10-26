// Copyright 2026 the AAI authors. MIT license.
/**
 * The wire name a DEPLOYED agent registered a tool def under, read back by the
 * def's IDENTITY.
 *
 * A tool is a FILE: its name is the file's, recorded nowhere on the def
 * (`AgentDef.tools`), and the registry's entry IS the file's default export —
 * `toolRegistry` stores the exported object itself, never a copy. So the one
 * thing that can connect a def a spec imported to the name the model called is
 * the discovery step that paired them, and this is where that pairing is kept:
 * `deployedAgent` (and so `virtual:aai/agent`) records each name as it lowers
 * the files, and a reader handed the def asks here.
 *
 * It is what lets an eval reader take the def rather than a string —
 * `toolResultIn(calls, placeOrder)` — and answer `InferToolOutput<typeof
 * placeOrder>`: the def carries the result type, the recording carries the
 * name, and a renamed file fails at the lookup naming the def's description
 * rather than three assertions later on a field of `undefined`.
 *
 * A `WeakMap`, so a def discovered once is never kept alive by this module. The
 * same def lowered under two names (two agents sharing one file) keeps the LAST
 * name recorded, which is the agent most recently imported as deployed; a spec
 * driving two such agents at once names the tool by its string instead.
 *
 * @module _testing-tool-names
 */

import type { ToolInputSchema } from "./schema.ts";
import type { ToolDef } from "./types.ts";

/** Def → the name a deployed agent registered it under. */
const NAMES = new WeakMap<object, string>();

/**
 * Record the name each def of a lowered `tools/` table was registered under.
 * Called by `deployedAgent` as it discovers a project's files.
 */
export function recordToolNames(tools: Readonly<Record<string, ToolDef<ToolInputSchema>>>): void {
  for (const [name, def] of Object.entries(tools)) NAMES.set(def, name);
}

/**
 * The name the model calls `def` by — the `tools/<name>.ts` file it was
 * discovered from.
 *
 * Only a def a DEPLOYED agent registered has one: import the agent as
 * `virtual:aai/agent` under vitest, or lower it with `deployedAgent`, before
 * reading a tool by its def. A def built inline in a spec has never been a
 * file, so it has no name, and the throw says so — as it does for a ROSTER
 * tool (one declared on a persona's `tools`), which is minted under the
 * speaker rather than discovered from a file and is read by its name string.
 *
 * @throws When `def` was never registered by a deployed agent.
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
      `toolNameOf(def) was handed a tool no deployed agent registered${describeDef(def)}. ` +
        "A FILE tool's name is its file name, recorded when the agent is imported as DEPLOYED — " +
        "import it as `virtual:aai/agent` under vitest, or lower it with `deployedAgent` from " +
        "@alexkroman1/aai/testing, before reading it by its def. A tool declared on a " +
        "persona's `tools` (a roster) is minted under the speaker, not from a file, and has " +
        "no recorded name: read it by its NAME string instead, e.g. " +
        'toolResultIn(calls, "lookup_invoice"). A def built inline in a spec has no name ' +
        "either; call its `execute` directly, or name the tool by its string.",
    );
  }
  return name;
}

/** The def's description, when it has one, so the message says WHICH tool. */
function describeDef(def: ToolDef<ToolInputSchema>): string {
  return typeof def.description === "string" && def.description !== ""
    ? ` (described as ${JSON.stringify(def.description.slice(0, 60))})`
    : "";
}
