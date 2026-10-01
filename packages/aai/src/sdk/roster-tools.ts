// Copyright 2026 the AAI authors. MIT license.
/**
 * How `agent({ roster })` LOWERS a roster into a {@link Toolset} — the half of
 * `sdk/roster.ts` that `agent()` calls and an author never does.
 *
 * Three things come out of one roster, all in one `"roster"` toolset so they are
 * schema'd, gated and executed by the paths every other tool takes, on all
 * three transports (the guest holds the agent's own module, the only side that
 * can hold a `SpeakerDef`'s functions anyway):
 *
 * 1. **Every SPEAKING entry's own tools, GATED on who is on the line.** The gate
 *    ({@link Toolset.gate}) answers a `ToolRefusal` with `reason: "persona"`
 *    naming who is speaking and how to hand off — the advertised list is fixed
 *    per session, so the one place a rule about WHO may call can hold is the
 *    call. The def passes through untouched (schema, `messages`, `onError`,
 *    and its executor — a speaker may own a `clientTool`).
 * 2. **`handoff`** over the speaking entries — the MODEL puts one on the line.
 * 3. **`delegate`** over the rest — the MODEL hands one a task, and gets its
 *    answer back (`ctx.delegate`). One tool with an enum rather than one per
 *    entry: the list costs one schema per request, and a shared instruction
 *    about briefing lives in one description.
 *
 * Each minted tool's description renders the roster (`- name: description`),
 * because an enum alone gives the model names and no way to tell them apart.
 * Neither recurses: a delegated run's own tools cannot delegate
 * (`NESTED_DELEGATE_MESSAGE` in `aai-runtime`).
 */

import { z } from "zod";
import { omitUndefined } from "./omit-undefined.ts";
import { DELEGATE_TOOL_NAME, HANDOFF_TOOL_NAME, type Roster } from "./roster.ts";
import type { SpeakerDef } from "./speaker.ts";
import type { ToolDef } from "./tool-def.ts";
import { type Toolset, toolset } from "./toolset.ts";
import { errorMessage, toolRefusal } from "./utils.ts";

/**
 * The toolset a roster contributes. Called by `agent()`.
 *
 * @internal
 */
export function rosterToolset(handle: Roster): Toolset {
  const tools: Record<string, ToolDef> = {};
  const owners = new Map<string, string>();
  for (const owner of handle.speaking) {
    for (const [name, def] of Object.entries(owner.tools ?? {})) {
      tools[name] = def;
      owners.set(name, owner.name);
    }
  }
  if (handle.speaking.length > 0) tools[HANDOFF_TOOL_NAME] = handoffTool(handle);
  if (handle.delegates.length > 0) tools[DELEGATE_TOOL_NAME] = delegateTool(handle.delegates);
  return toolset("roster", tools, (name, _def, ctx) => {
    const owner = owners.get(name);
    if (owner === undefined) return;
    const speaking = handle.active(ctx).name;
    if (speaking === owner) return;
    return toolRefusal(
      "persona",
      `"${name}" belongs to the ${owner} persona, and ${speaking} is speaking. ` +
        `Hand the caller to ${owner} first (the ${HANDOFF_TOOL_NAME} tool), then call it.`,
    );
  });
}

/** The minted `handoff` tool — see the module doc. */
function handoffTool(handle: Roster): ToolDef {
  // zod wants a non-empty tuple; the caller has established one.
  const names = handle.speaking.map((one) => one.name) as [string, ...string[]];
  const inputSchema = z.object({
    persona: z.enum(names).describe("Who should speak from here on."),
    note: z
      .string()
      .optional()
      .describe(
        "What the next speaker needs to know that the transcript does not say — what is " +
          "already verified, what the caller wants, what has been ruled out.",
      ),
  });
  // Annotated on the CONST so `execute`'s parameters are contextually typed by
  // the schema; a bare `ToolDef` return types them as an untyped record.
  const def: ToolDef<typeof inputSchema> = {
    description: describe(
      "Hand the caller to another speaker, who speaks from the next step on. Use this " +
        "when the request is squarely another speaker's job. The conversation continues — " +
        "do not restart it, and do not announce a transfer before this tool has answered.",
      "Speakers",
      handle.speaking,
    ),
    inputSchema,
    execute({ persona, note }, ctx) {
      if (!names.includes(persona)) {
        return toolRefusal(
          "roster",
          `There is no speaker called "${persona}". Available: ${names.join(", ")}.`,
        );
      }
      try {
        return handle.handoff(ctx, persona, note === undefined ? {} : { note });
      } catch (err: unknown) {
        // A dialog pin: an authoring mistake from code, a recoverable refusal here.
        return toolRefusal("persona", errorMessage(err));
      }
    },
  };
  return def;
}

/** The minted `delegate` tool — see the module doc. */
function delegateTool(entries: readonly SpeakerDef[]): ToolDef {
  const byName = new Map(entries.map((one) => [one.name, one]));
  const names = entries.map((one) => one.name) as [string, ...string[]];
  const inputSchema = z.object({
    subagent: z.enum(names).describe("Which speaker should do this."),
    task: z
      .string()
      .describe(
        "The COMPLETE brief. The speaker has not heard this conversation and " +
          "knows nothing you do not tell it here.",
      ),
    context: z
      .string()
      .optional()
      .describe(
        "Anything already established that the speaker should not go looking " +
          "for again, or already ruled out.",
      ),
  });
  const def: ToolDef<typeof inputSchema> = {
    description: describe(
      "Hand a self-contained task to a speaker who works off the line, and get its answer " +
        "back. Use this when a request is squarely one of theirs — not for something you " +
        "can answer yourself, and not to ask one what it thinks of another's answer.",
      "Available",
      entries,
    ),
    inputSchema,
    async execute({ subagent, task, context }, ctx) {
      // Unreachable through the enum, and checked anyway: a repaired tool call or
      // a provider ignoring the enum can send a name no schema sanctioned.
      const chosen = byName.get(subagent);
      if (!chosen) {
        return toolRefusal(
          "roster",
          `There is no speaker called "${subagent}". Available: ${names.join(", ")}.`,
        );
      }
      const result = await ctx.delegate(chosen, { task, ...omitUndefined({ context }) });
      return {
        subagent,
        answer: result.text,
        /** What the wait bought, so the agent can say something true about it. */
        lookups: result.toolCalls.length,
        // Present only when the guardrail never accepted — a field whose
        // PRESENCE is the warning (the contract sets `complaint` exactly then).
        ...omitUndefined({ unverified: result.complaint }),
      };
    },
  };
  return def;
}

/** A minted tool's description: what it does, then who is on the list. */
function describe(what: string, heading: string, entries: readonly SpeakerDef[]): string {
  return [
    what,
    "",
    `${heading}:`,
    ...entries.map((one) => `- ${one.name}: ${one.description}`),
  ].join("\n");
}
