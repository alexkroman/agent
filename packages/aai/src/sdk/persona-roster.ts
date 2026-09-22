// Copyright 2026 the AAI authors. MIT license.
/**
 * How `agent({ personas })` LOWERS a roster into the agent's tool table — the
 * half of `sdk/persona.ts` that `agent()` calls and an author never does.
 *
 * Two things come out of a roster and both are ordinary entries in `tools`, so
 * they are schema'd, dispatched and executed by the same paths a `tools/` file
 * takes, on all three transports, and the sandbox path needs nothing (the guest
 * holds the agent's own module, which is the only side that can hold a
 * `PersonaDef`'s functions anyway — the same argument `sdk/subagent-roster.ts`
 * makes for `delegate`):
 *
 * 1. **Every persona's own tools, each wrapped in a GATE.** The wrapper runs the
 *    tool only while its owner is speaking and otherwise answers a
 *    `ToolFailure` naming who is, and how to hand off. That is the move
 *    `dialog.tool` makes for the same reason `sdk/dialog.ts` gives: the
 *    advertised tool list is fixed per session on every transport, so the one
 *    place a rule about WHO may call a tool can hold everywhere is the call.
 * 2. **One `handoff` tool** whose `persona` argument is an enum over the names,
 *    described by each persona's `description` — so the MODEL routes, which is
 *    the shape a front desk needs. The other way to hand off,
 *    `Personas.handoff` from a tool body, is the author routing in code; the
 *    two compose.
 *
 * Split from `persona.ts` at the seam the subagent pair already uses: that
 * file holds the contract an author writes against, this holds what the
 * runtime is handed.
 */

import { z } from "zod";
import { HANDOFF_TOOL_NAME, type PersonaDef, type Personas } from "./persona.ts";
import type { ToolDef } from "./tool-def.ts";
import { errorMessage, toolFailure } from "./utils.ts";

/**
 * The tool table a roster contributes: every persona's gated tools plus the
 * minted `handoff` tool. Called by `agent()`.
 *
 * @internal
 */
export function personaTools(roster: Personas): Record<string, ToolDef> {
  const table: Record<string, ToolDef> = {};
  for (const owner of roster.list) {
    for (const [name, def] of Object.entries(owner.tools ?? {})) {
      table[name] = gated(roster, owner, name, def);
    }
  }
  table[HANDOFF_TOOL_NAME] = handoffTool(roster);
  return table;
}

/**
 * One persona's tool, refusing outside its owner's turn.
 *
 * Everything but `execute` passes through untouched — description, schema,
 * `messages`, `onError` — so the model sees the tool the author wrote and a
 * throw is still classified by the author's own handler. Only the body is
 * wrapped, and the wrapper is the whole gate.
 */
function gated(roster: Personas, owner: PersonaDef, name: string, def: ToolDef): ToolDef {
  return {
    ...def,
    execute(args, ctx) {
      const speaking = roster.active(ctx);
      if (speaking.name === owner.name) return def.execute(args, ctx);
      return toolFailure(
        `"${name}" belongs to the ${owner.name} persona, and ${speaking.name} is speaking. ` +
          `Hand the caller to ${owner.name} first (the ${HANDOFF_TOOL_NAME} tool), then call it.`,
      );
    },
  };
}

/** The minted `handoff` tool — see the module doc. */
function handoffTool(roster: Personas): ToolDef {
  // zod wants a non-empty tuple; `personas()` has already established one.
  const names = roster.list.map((one) => one.name) as [string, ...string[]];
  const inputSchema = z.object({
    persona: z.enum(names).describe("Who should speak from here on."),
    note: z
      .string()
      .optional()
      .describe(
        "What the next persona needs to know that the transcript does not say — what is " +
          "already verified, what the caller wants, what has been ruled out.",
      ),
  });
  // Annotated on the CONST so `execute`'s parameters are contextually typed by
  // the schema above — the same move `rosterTool` makes and for the same reason.
  const def: ToolDef<typeof inputSchema> = {
    description: describeRoster(roster.list),
    inputSchema,
    execute({ persona, note }, ctx) {
      try {
        return roster.handoff(ctx, persona, note === undefined ? {} : { note });
      } catch (err: unknown) {
        // A pinned persona or an off-roster name: an authoring mistake when it
        // comes from code, and a recoverable refusal when the model asked.
        return toolFailure(errorMessage(err));
      }
    },
  };
  return def;
}

/**
 * The tool description: what handing off is, then who is available. The
 * roster is rendered INTO the description as well as being the enum, because
 * an enum gives the model a list of names and no way to tell them apart.
 */
function describeRoster(list: readonly PersonaDef[]): string {
  return [
    "Hand the caller to another persona, who speaks from the next step on. Use this " +
      "when the request is squarely another persona's job. The conversation continues — " +
      "do not restart it, and do not announce a transfer before this tool has answered.",
    "",
    "Personas:",
    ...list.map((one) => `- ${one.name}: ${one.description}`),
  ].join("\n");
}
